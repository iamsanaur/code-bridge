import * as Crypto from 'expo-crypto';

/** RFC 4122 v4 UUID from a CSPRNG (used for idempotency keys and command ids). */
export const uuid = (): string => Crypto.randomUUID();
