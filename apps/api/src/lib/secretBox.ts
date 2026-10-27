import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope for provider API keys stored server-side (cloud sessions only).
 * The key comes from CREDENTIAL_ENCRYPTION_KEY; in production it should be injected
 * from a KMS / secrets manager. `keyVersion` is stored alongside each ciphertext to
 * support key rotation. The user id is bound as additional authenticated data so a
 * ciphertext cannot be moved to another user's row.
 */
export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(
    keyB64: string,
    private readonly keyVersion: number,
  ) {
    this.key = Buffer.from(keyB64, 'base64');
    if (this.key.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes');
  }

  seal(plaintext: string, aad: string): SealedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: this.keyVersion };
  }

  open(sealed: SealedSecret, aad: string): string {
    if (sealed.keyVersion !== this.keyVersion) {
      throw new Error(
        `credential encrypted with key version ${sealed.keyVersion}; current is ${this.keyVersion}`,
      );
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(sealed.authTag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  }
}
