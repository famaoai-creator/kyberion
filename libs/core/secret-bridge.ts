/* eslint-disable no-restricted-imports -- IP-08 で managed-process 経由へ移行予定 (docs/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeWriteFile, safeMkdir } from './secure-io.js';
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

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private readSecretsFile(): Record<string, Record<string, string>> {
    if (!safeExistsSync(FILE_SECRETS_PATH)) return {};
    try {
      return JSON.parse(safeReadFile(FILE_SECRETS_PATH, { encoding: 'utf8' }) as string);
    } catch {
      return {};
    }
  }

  private writeSecretsFile(secrets: Record<string, Record<string, string>>): void {
    const dir = path.dirname(FILE_SECRETS_PATH);
    if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
    safeWriteFile(FILE_SECRETS_PATH, JSON.stringify(secrets, null, 2));
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
