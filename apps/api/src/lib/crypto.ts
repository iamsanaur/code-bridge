import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Generates an opaque credential like `cba_<43 base64url chars>` (256 bits of entropy). */
export function generateToken(prefix: 'cba' | 'cbr' | 'cbd' | 'cbp'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

/** Tokens are high-entropy, so a fast hash is appropriate (no need for a password KDF). */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Deterministic UUID for (user, idempotency key), so client retries never create duplicates. */
export function deterministicId(userId: string, key: string): string {
  const h = createHash('sha256').update(`${userId}:${key}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50; // version 5-style
  h[8] = (h[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
