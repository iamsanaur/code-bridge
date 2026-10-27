import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Device-specific secret storage: iOS Keychain / Android Keystore via expo-secure-store.
 * Only CodeBridge session tokens are stored here – never Anthropic API keys.
 *
 * On web (development preview only) there is no secure storage, so values are
 * kept in memory and lost on reload.
 */
const memory = new Map<string, string>();
const isWeb = Platform.OS === 'web';

const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const secureStorage = {
  async get(key: string): Promise<string | null> {
    if (isWeb) return memory.get(key) ?? null;
    return SecureStore.getItemAsync(key, options);
  },
  async set(key: string, value: string): Promise<void> {
    if (isWeb) {
      memory.set(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value, options);
  },
  async delete(key: string): Promise<void> {
    if (isWeb) {
      memory.delete(key);
      return;
    }
    await SecureStore.deleteItemAsync(key, options);
  },
  isPersistent: !isWeb,
};
