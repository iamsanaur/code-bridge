package dev.codebridge.core

import kotlinx.serialization.Serializable

/**
 * The relay this phone is connected to and the secret that lets it sign in again. The secret stays on
 * this device (Android Keystore-encrypted) so an expired or lost session reconnects silently.
 */
@Serializable
data class RelayConnection(val server: String, val secret: String)

interface RelayStore {
    suspend fun load(): RelayConnection?
    suspend fun save(relay: RelayConnection)
    suspend fun clear()
}

class InMemoryRelayStore(private var relay: RelayConnection? = null) : RelayStore {
    override suspend fun load() = relay
    override suspend fun save(relay: RelayConnection) { this.relay = relay }
    override suspend fun clear() { relay = null }
}
