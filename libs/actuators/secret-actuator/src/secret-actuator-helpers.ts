import { logger, safeReadFile, safeWriteFile, safeExec, ledger, classifyError, withRetry, safeExistsSync, safeMkdir, fetchSecret, storeSecret, removeSecret, listSecrets as coreListSecrets, pathResolver } from '@agent/core';
import * as path from 'node:path';

/**
 * Secret-Actuator v1.0.0 [SOVEREIGN NATIVE BRIDGE]
 * Integrates with OS Native Secret Managers (macOS Keychain, etc.)
 */

const SECRET_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/secret-actuator/manifest.json');
const KEYCHAIN_REGISTRY_PATH = pathResolver.vault('secrets/keychain-registry.json');

const DEFAULT_SECRET_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  factor: 2,
  jitter: true,
};

let cachedRecoveryPolicy: Record<string, any> | null = null;

interface RegistryEntry {
  service: string;
  account: string;
  addedAt: string;
}

interface KeychainRegistry {
  entries: RegistryEntry[];
}

interface SecretAction {
  action: 'get' | 'set' | 'delete' | 'list';
  params: {
    account?: string;
    service: string;
    value?: string;
    export_as?: string;
  };
}

function loadRegistry(): KeychainRegistry {
  if (!safeExistsSync(KEYCHAIN_REGISTRY_PATH)) return { entries: [] };
  try {
    return JSON.parse(safeReadFile(KEYCHAIN_REGISTRY_PATH, { encoding: 'utf8' }) as string) as KeychainRegistry;
  } catch {
    return { entries: [] };
  }
}

function saveRegistry(registry: KeychainRegistry): void {
  const dir = path.dirname(KEYCHAIN_REGISTRY_PATH);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(KEYCHAIN_REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

function registryAdd(service: string, account: string): void {
  const registry = loadRegistry();
  const existing = registry.entries.findIndex(e => e.service === service && e.account === account);
  const entry: RegistryEntry = { service, account, addedAt: new Date().toISOString() };
  if (existing >= 0) {
    registry.entries[existing] = entry;
  } else {
    registry.entries.push(entry);
  }
  saveRegistry(registry);
}

function registryRemove(service: string, account: string): void {
  const registry = loadRegistry();
  registry.entries = registry.entries.filter(e => !(e.service === service && e.account === account));
  saveRegistry(registry);
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(safeReadFile(SECRET_MANIFEST_PATH, { encoding: 'utf8' }) as string);
    cachedRecoveryPolicy = isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
    return cachedRecoveryPolicy;
  } catch (_) {
    cachedRecoveryPolicy = {};
    return cachedRecoveryPolicy;
  }
}

function buildRetryOptions(override?: Record<string, any>) {
  const recoveryPolicy = loadRecoveryPolicy();
  const manifestRetry = isPlainObject(recoveryPolicy.retry) ? recoveryPolicy.retry : {};
  const retryableCategories = new Set<string>(
    Array.isArray(recoveryPolicy.retryable_categories) ? recoveryPolicy.retryable_categories.map(String) : [],
  );
  const resolved = {
    ...DEFAULT_SECRET_RETRY,
    ...manifestRetry,
    ...(override || {}),
  };
  return {
    ...resolved,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      if (retryableCategories.size > 0) {
        return retryableCategories.has(classification.category);
      }
      return classification.category === 'network'
        || classification.category === 'rate_limit'
        || classification.category === 'timeout'
        || classification.category === 'resource_unavailable';
    },
  };
}

async function withGovernedMutation(
  actionType: 'set' | 'delete',
  params: any,
  platform: string,
  logic: () => Promise<any>
) {
  const existingMissionId = process.env.MISSION_ID;
  const isEphemeral = !existingMissionId;
  const missionId = existingMissionId || `MSN-SEC-${Date.now().toString(36).toUpperCase()}`;

  if (isEphemeral) {
    logger.info(`🛡️ [SECRET-GUARD] No active mission found. Auto-wrapping mutation in ephemeral mission: ${missionId}`);
    try {
      safeExec('node', ['--import', 'scripts/ts-loader.mjs', 'scripts/mission_controller.ts', 'create', missionId, 'personal', 'kyberion', 'governance', '"Ephemeral Secret Mutation"', 'Unknown', '--is-ephemeral']);
      safeExec('node', ['--import', 'scripts/ts-loader.mjs', 'scripts/mission_controller.ts', 'start', missionId, 'personal']);
    } catch (err) {
      logger.warn(`Failed to create ephemeral mission: ${err}`);
    }
  }

  let result;
  try {
    result = await logic();
    if (result.status === 'success') {
      ledger.record('CONFIG_CHANGE', {
        mission_id: missionId,
        role: process.env.MISSION_ROLE || 'secret_guard',
        service_id: params.service,
        config_target: 'os-keychain',
        action: actionType,
        changed_keys: [params.account]
      });
      result.mission_id = missionId;
    }
    return result;
  } catch (err: any) {
    return { status: 'failed', error: err?.message ?? String(err) };
  } finally {
    if (isEphemeral) {
      try {
        safeExec('node', ['--import', 'scripts/ts-loader.mjs', 'scripts/mission_controller.ts', 'finish', missionId]);
      } catch (err) {
        logger.warn(`Failed to finish ephemeral mission: ${err}`);
      }
    }
  }
}

export async function handleAction(input: SecretAction) {
  const platform = process.platform;

  switch (input.action) {
    case 'get': return await getSecret(input.params, platform);
    case 'set':
      return await withGovernedMutation('set', input.params, platform, () => setSecret(input.params, platform));
    case 'delete':
      return await withGovernedMutation('delete', input.params, platform, () => deleteSecret(input.params, platform));
    case 'list':
      return listSecrets(input.params);
    default: throw new Error(`Unsupported secret action: ${(input as any).action}`);
  }
}

async function getSecret(params: any, platform: string) {
  try {
    const value = await withRetry(async () => fetchSecret(params.service, params.account), buildRetryOptions());
    if (value === null) {
      return { status: 'failed', error: 'Secret not found.' };
    }
    return { status: 'success', [params.export_as || 'secret_value']: value };
  } catch (err: any) {
    return { status: 'failed', error: err.message || 'Secret not found.' };
  }
}

async function setSecret(params: any, platform: string) {
  if (!params.value) throw new Error('Value is required for "set" action.');
  if (!params.account) throw new Error('Account is required for "set" action.');

  try {
    await withRetry(async () => storeSecret(params.service, params.account, params.value), buildRetryOptions());
    registryAdd(params.service, params.account);
    return { status: 'success', message: 'Secret stored.' };
  } catch (err: any) {
    return { status: 'failed', error: err.message };
  }
}

async function deleteSecret(params: any, platform: string) {
  if (!params.account) throw new Error('Account is required for "delete" action.');

  try {
    await withRetry(async () => removeSecret(params.service, params.account), buildRetryOptions());
    registryRemove(params.service, params.account);
    return { status: 'success', message: 'Secret deleted.' };
  } catch (err: any) {
    return { status: 'failed', error: err.message };
  }
}

function listSecrets(params: { service: string }): { status: string; entries: RegistryEntry[] } {
  return coreListSecrets(params.service);
}
