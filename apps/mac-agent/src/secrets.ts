import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

export type SecretName = 'device-secret' | 'anthropic-api-key';

export interface SecretStore {
  readonly kind: string;
  get(name: SecretName): Promise<string | null>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
}

const SERVICE = 'dev.codebridge.agent';

interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(p: string): void;
  deletePassword(): boolean;
}

/**
 * macOS Keychain (via @napi-rs/keyring, which uses the Security framework).
 * Items are stored in the user's login keychain under service `dev.codebridge.agent`.
 */
export class KeychainStore implements SecretStore {
  readonly kind = 'keychain';
  private readonly Entry: new (service: string, account: string) => KeyringEntry;

  constructor() {
    const require = createRequire(import.meta.url);
    const mod = require('@napi-rs/keyring') as {
      Entry: new (s: string, a: string) => KeyringEntry;
    };
    this.Entry = mod.Entry;
  }

  async get(name: SecretName): Promise<string | null> {
    try {
      return new this.Entry(SERVICE, name).getPassword() ?? null;
    } catch {
      return null;
    }
  }
  async set(name: SecretName, value: string): Promise<void> {
    new this.Entry(SERVICE, name).setPassword(value);
  }
  async delete(name: SecretName): Promise<void> {
    try {
      new this.Entry(SERVICE, name).deletePassword();
    } catch {
      // not present
    }
  }
}

/**
 * DEVELOPMENT ONLY: plaintext file (mode 0600). Used on Linux CI/containers where
 * no OS keychain exists. Enabled only with CODEBRIDGE_INSECURE_FILE_SECRETS=1.
 */
export class FileSecretStore implements SecretStore {
  readonly kind = 'file (insecure, development only)';
  constructor(private readonly dir: string) {}
  private get file() {
    return path.join(this.dir, 'secrets.dev.json');
  }
  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  async get(name: SecretName) {
    return (await this.read())[name] ?? null;
  }
  async set(name: SecretName, value: string) {
    const all = await this.read();
    all[name] = value;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.file, JSON.stringify(all), { mode: 0o600 });
    await chmod(this.file, 0o600);
  }
  async delete(name: SecretName) {
    const all = await this.read();
    delete all[name];
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.file, JSON.stringify(all), { mode: 0o600 });
  }
}

export class MemorySecretStore implements SecretStore {
  readonly kind = 'memory';
  private readonly map = new Map<SecretName, string>();
  async get(name: SecretName) {
    return this.map.get(name) ?? null;
  }
  async set(name: SecretName, value: string) {
    this.map.set(name, value);
  }
  async delete(name: SecretName) {
    this.map.delete(name);
  }
}

export function createSecretStore(dir: string): SecretStore {
  if (process.env.CODEBRIDGE_INSECURE_FILE_SECRETS === '1') {
    console.warn(
      'WARNING: storing CodeBridge secrets in a plaintext file (CODEBRIDGE_INSECURE_FILE_SECRETS=1). Development only.',
    );
    return new FileSecretStore(dir);
  }
  return new KeychainStore();
}
