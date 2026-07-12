/* eslint-disable no-restricted-imports -- IP-08 で managed-process 経由へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import {
  safeChmodSync,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
} from './secure-io.js';
import { SecretProvider, RegistryEntry, SecretResult } from './secret-types.js';

const KEYCHAIN_REGISTRY_PATH = pathResolver.vault('secrets/keychain-registry.json');
const FILE_SECRETS_PATH = pathResolver.vault('secrets/file-secrets.json');

// Helper to manage the registry catalog
interface KeychainRegistry {
  entries: RegistryEntry[];
}

function loadRegistry(): KeychainRegistry {
  if (!safeExistsSync(KEYCHAIN_REGISTRY_PATH)) return { entries: [] };
  try {
    return JSON.parse(
      safeReadFile(KEYCHAIN_REGISTRY_PATH, { encoding: 'utf8' }) as string
    ) as KeychainRegistry;
  } catch {
    return { entries: [] };
  }
}

function saveRegistry(registry: KeychainRegistry): void {
  const dir = path.dirname(KEYCHAIN_REGISTRY_PATH);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(KEYCHAIN_REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

export function registryAdd(service: string, account: string): void {
  const registry = loadRegistry();
  const existing = registry.entries.findIndex(
    (e) => e.service === service && e.account === account
  );
  const entry: RegistryEntry = { service, account, addedAt: new Date().toISOString() };
  if (existing >= 0) {
    registry.entries[existing] = entry;
  } else {
    registry.entries.push(entry);
  }
  saveRegistry(registry);
}

export function registryRemove(service: string, account: string): void {
  const registry = loadRegistry();
  registry.entries = registry.entries.filter(
    (e) => !(e.service === service && e.account === account)
  );
  saveRegistry(registry);
}

// 1. macOS Keychain native provider
export class MacKeychainSecretProvider implements SecretProvider {
  readonly id = 'mac_keychain';

  async isAvailable(): Promise<boolean> {
    return process.platform === 'darwin';
  }

  async get(service: string, account: string): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn(
        'security',
        ['find-generic-password', '-a', account, '-s', service, '-w'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          resolve(null);
        }
      });
    });
  }

  async set(service: string, account: string, value: string): Promise<void> {
    // Delete first to overwrite safely
    await this.delete(service, account);

    return new Promise((resolve, reject) => {
      const child = spawn(
        'security',
        ['add-generic-password', '-a', account, '-s', service, '-w', value],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
        }
      );
      child.on('close', (code) => {
        if (code === 0) {
          registryAdd(service, account);
          resolve();
        } else {
          reject(new Error(`macOS Keychain write failed with code ${code}`));
        }
      });
    });
  }

  async delete(service: string, account: string): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn('security', ['delete-generic-password', '-a', account, '-s', service], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('close', () => {
        registryRemove(service, account);
        resolve();
      });
    });
  }
}

// 2. Local File Secret Provider (Fallback for Headless Linux/Windows)
export class FileSecretProvider implements SecretProvider {
  readonly id = 'file_secrets';

  constructor(private readonly secretsPath = FILE_SECRETS_PATH) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private readSecretsFile(): Record<string, Record<string, string>> {
    if (!safeExistsSync(this.secretsPath)) return {};
    this.assertNotSymlink(this.secretsPath, 'secret file');
    try {
      return JSON.parse(safeReadFile(this.secretsPath, { encoding: 'utf8' }) as string);
    } catch {
      return {};
    }
  }

  private writeSecretsFile(secrets: Record<string, Record<string, string>>): void {
    const dir = path.dirname(this.secretsPath);
    if (safeExistsSync(dir)) {
      this.assertNotSymlink(dir, 'secret directory');
    } else {
      safeMkdir(dir, { recursive: true, mode: 0o700 });
    }
    safeChmodSync(dir, 0o700);
    if (safeExistsSync(this.secretsPath)) {
      this.assertNotSymlink(this.secretsPath, 'secret file');
    }
    safeWriteFile(this.secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    // Also repair permissions of files created by older versions.
    safeChmodSync(this.secretsPath, 0o600);
  }

  private assertNotSymlink(targetPath: string, label: string): void {
    if (safeLstat(targetPath).isSymbolicLink()) {
      throw new Error(`[SECURITY] Refusing ${label} symbolic link: ${targetPath}`);
    }
  }

  async get(service: string, account: string): Promise<string | null> {
    const secrets = this.readSecretsFile();
    return secrets[service]?.[account] || null;
  }

  async set(service: string, account: string, value: string): Promise<void> {
    const secrets = this.readSecretsFile();
    if (!secrets[service]) secrets[service] = {};
    secrets[service][account] = value;
    this.writeSecretsFile(secrets);
    registryAdd(service, account);
  }

  async delete(service: string, account: string): Promise<void> {
    const secrets = this.readSecretsFile();
    if (secrets[service]) {
      delete secrets[service][account];
      if (Object.keys(secrets[service]).length === 0) {
        delete secrets[service];
      }
      this.writeSecretsFile(secrets);
    }
    registryRemove(service, account);
  }
}

// 3. Environment Variable Secret Provider
export class EnvSecretProvider implements SecretProvider {
  readonly id = 'env_secrets';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private envKey(service: string, account: string): string {
    return `SECRET_${service.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${account.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  }

  async get(service: string, account: string): Promise<string | null> {
    const key = this.envKey(service, account);
    return process.env[key] || null;
  }

  async set(service: string, account: string, value: string): Promise<void> {
    const key = this.envKey(service, account);
    process.env[key] = value;
    registryAdd(service, account);
  }

  async delete(service: string, account: string): Promise<void> {
    const key = this.envKey(service, account);
    delete process.env[key];
    registryRemove(service, account);
  }
}

// Adaptive policy router
let warnedFileSecretFallback = false;

export class SecretPolicyRouter {
  private providers: Map<string, SecretProvider> = new Map();

  constructor(providers: SecretProvider[]) {
    for (const p of providers) {
      this.providers.set(p.id, p);
    }
  }

  async selectProvider(): Promise<SecretProvider> {
    // Platform priority: native keychain on macOS, file secrets/env secrets on others
    const chain = ['mac_keychain', 'file_secrets', 'env_secrets'];
    for (const id of chain) {
      const provider = this.providers.get(id);
      if (provider && (await provider.isAvailable())) {
        if (id === 'file_secrets' && !process.env.KYBERION_ALLOW_FILE_SECRETS) {
          // Warn-phase (REVIEW_CODEX_2026-07-11 / AC-05): plaintext-JSON file
          // secrets engage silently when the keychain is unavailable. TODO:
          // after the warn observation period and AC-05 Task 2 (encryption
          // option), make unacknowledged fallback fail-closed.
          if (!warnedFileSecretFallback) {
            warnedFileSecretFallback = true;
            logger.warn(
              '[SECRET_BRIDGE] Falling back to plaintext file secrets (keychain unavailable). ' +
                'Set KYBERION_ALLOW_FILE_SECRETS=1 to acknowledge, or configure the OS keychain.'
            );
          }
        }
        return provider;
      }
    }
    throw new Error('No available Secret Provider resolved.');
  }
}

let globalRouter: SecretPolicyRouter | null = null;

function getRouter(): SecretPolicyRouter {
  if (!globalRouter) {
    globalRouter = new SecretPolicyRouter([
      new MacKeychainSecretProvider(),
      new FileSecretProvider(),
      new EnvSecretProvider(),
    ]);
  }
  return globalRouter;
}

export async function fetchSecret(service: string, account: string): Promise<string | null> {
  const router = getRouter();
  const provider = await router.selectProvider();
  return await provider.get(service, account);
}

export async function storeSecret(service: string, account: string, value: string): Promise<void> {
  const router = getRouter();
  const provider = await router.selectProvider();
  await provider.set(service, account, value);
}

export async function removeSecret(service: string, account: string): Promise<void> {
  const router = getRouter();
  const provider = await router.selectProvider();
  await provider.delete(service, account);
}

export function listSecrets(service?: string): { status: string; entries: RegistryEntry[] } {
  const registry = loadRegistry();
  const entries = service
    ? registry.entries.filter((e) => e.service === service)
    : registry.entries;
  return { status: 'success', entries };
}
