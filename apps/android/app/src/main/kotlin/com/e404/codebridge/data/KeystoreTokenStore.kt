package com.e404.codebridge.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import dev.codebridge.core.ProtocolJson
import dev.codebridge.core.RelayConnection
import dev.codebridge.core.RelayStore
import dev.codebridge.core.TokenPair
import dev.codebridge.core.TokenStore
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * One value encrypted with an AES-256-GCM key that lives in the Android Keystore (hardware-backed where
 * available) and never leaves it.
 */
internal class KeystoreBlob(context: Context, private val pref: String, private val alias: String) {
    private val prefs = context.getSharedPreferences("codebridge.secure", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    suspend fun read(): String? = withContext(Dispatchers.IO) {
        val blob = prefs.getString(pref, null) ?: return@withContext null
        runCatching {
            val bytes = Base64.decode(blob, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
            cipher.doFinal(bytes, 12, bytes.size - 12).decodeToString()
        }.getOrElse {
            // Key invalidated (e.g. device restored) or data corrupt: start again.
            prefs.edit().remove(pref).apply()
            null
        }
    }

    suspend fun write(plain: String) = withContext(Dispatchers.IO) {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(plain.encodeToByteArray())
        prefs.edit().putString(pref, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
    }

    suspend fun remove() = withContext(Dispatchers.IO) { prefs.edit().remove(pref).apply() }

    private companion object {
        const val TRANSFORM = "AES/GCM/NoPadding"
    }
}

/** CodeBridge session tokens only: never Anthropic API keys. */
class KeystoreTokenStore(context: Context) : TokenStore {
    private val blob = KeystoreBlob(context, "tokens", "codebridge_tokens_v1")
    override suspend fun load(): TokenPair? =
        blob.read()?.let { runCatching { ProtocolJson.decodeFromString(TokenPair.serializer(), it) }.getOrNull() }
    override suspend fun save(tokens: TokenPair) = blob.write(ProtocolJson.encodeToString(TokenPair.serializer(), tokens))
    override suspend fun clear() = blob.remove()
}

/** The relay this phone joined and its owner secret, so an expired session reconnects silently. */
class KeystoreRelayStore(context: Context) : RelayStore {
    private val blob = KeystoreBlob(context, "relay", "codebridge_relay_v1")
    override suspend fun load(): RelayConnection? =
        blob.read()?.let { runCatching { ProtocolJson.decodeFromString(RelayConnection.serializer(), it) }.getOrNull() }
    override suspend fun save(relay: RelayConnection) = blob.write(ProtocolJson.encodeToString(RelayConnection.serializer(), relay))
    override suspend fun clear() = blob.remove()
}
