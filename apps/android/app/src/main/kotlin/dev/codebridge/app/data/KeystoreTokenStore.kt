package dev.codebridge.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import dev.codebridge.core.ProtocolJson
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
 * Stores CodeBridge session tokens encrypted with an AES-256-GCM key that lives in
 * the Android Keystore (hardware-backed where available) and never leaves it.
 * Only CodeBridge tokens are stored here — never Anthropic API keys.
 */
class KeystoreTokenStore(context: Context) : TokenStore {
    private val prefs = context.getSharedPreferences("codebridge.secure", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    override suspend fun load(): TokenPair? = withContext(Dispatchers.IO) {
        val blob = prefs.getString(PREF, null) ?: return@withContext null
        runCatching {
            val bytes = Base64.decode(blob, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
            val plain = cipher.doFinal(bytes, 12, bytes.size - 12)
            ProtocolJson.decodeFromString(TokenPair.serializer(), plain.decodeToString())
        }.getOrElse {
            // Key invalidated (e.g. device restored) or data corrupt: sign in again.
            prefs.edit().remove(PREF).apply()
            null
        }
    }

    override suspend fun save(tokens: TokenPair) = withContext(Dispatchers.IO) {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(ProtocolJson.encodeToString(TokenPair.serializer(), tokens).encodeToByteArray())
        prefs.edit().putString(PREF, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
    }

    override suspend fun clear() = withContext(Dispatchers.IO) { prefs.edit().remove(PREF).apply() }

    private companion object {
        const val ALIAS = "codebridge_tokens_v1"
        const val PREF = "tokens"
        const val TRANSFORM = "AES/GCM/NoPadding"
    }
}
