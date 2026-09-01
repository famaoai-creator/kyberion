import {
  safeReadFile,
  safeWriteFile,
  safeExec,
  safeExistsSync,
  safeMkdir,
} from '@agent/core/secure-io';
import * as secureIo from '@agent/core/secure-io';
import { logger } from '@agent/core/core';
import { parseSafeJsonInput } from '@agent/core/foundation';
import { ledger } from '@agent/core/ledger';
import { createGovernedRetryOptionsBuilder } from '@agent/core/recovery-policy';
import { retry } from '@agent/core/async-utils';
import {
  fetchSecret,
  storeSecret,
  removeSecret,
  listSecrets as coreListSecrets,
} from '@agent/core/secret-bridge';
import * as pathResolver from '@agent/core/path-resolver';
import { ensureDefaultOpPreflight } from '@agent/core/op-preflight-defaults';
import { runOpPreflight } from '@agent/core/op-preflight';
import * as path from 'node:path';

/**
 * Secret-Actuator v1.0.0 [SOVEREIGN NATIVE BRIDGE]
 * Integrates with OS Native Secret Managers (macOS Keychain, etc.)
 */

const SECRET_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/secret-actuator/manifest.json'
);
const KEYCHAIN_REGISTRY_PATH = pathResolver.vault('secrets/keychain-registry.json');

// The registry is secret-adjacent metadata stored under vault/secrets.  Keep
// the global sensitive-path deny layer intact for callers, but mediate this
// actuator's own deliberate registry access explicitly.
function withVaultIo<T>(operation: () => T): T {
  return secureIo.withSensitivePathMediation(operation);
}

const DEFAULT_SECRET_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  factor: 2,
  jitter: true,
};

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
  if (!withVaultIo(() => safeExistsSync(KEYCHAIN_REGISTRY_PATH))) {
    return { entries: [] };
  }
  try {
    return parseSafeJsonInput(
      withVaultIo(() => safeReadFile(KEYCHAIN_REGISTRY_PATH, { encoding: 'utf8' })) as string,
      'secret keychain registry'
    ) as KeychainRegistry;
  } catch {
    return { entries: [] };
  }
}

function saveRegistry(registry: KeychainRegistry): void {
  const dir = path.dirname(KEYCHAIN_REGISTRY_PATH);
  if (!withVaultIo(() => safeExistsSync(dir))) {
    withVaultIo(() => safeMkdir(dir, { recursive: true }));
  }
  withVaultIo(() => safeWriteFile(KEYCHAIN_REGISTRY_PATH, JSON.stringify(registry, null, 2)));
}

function registryAdd(service: string, account: string): void {
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

function registryRemove(service: string, account: string): void {
  const registry = loadRegistry();
  registry.entries = registry.entries.filter(
    (e) => !(e.service === service && e.account === account)
  );
  saveRegistry(registry);
}

const buildRetryOptions = createGovernedRetryOptionsBuilder({
  manifestPath: SECRET_MANIFEST_PATH,
  defaults: DEFAULT_SECRET_RETRY,
  fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
});

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
    logger.info(
      `🛡️ [SECRET-GUARD] No active mission found. Auto-wrapping mutation in ephemeral mission: ${missionId}`
    );
    try {
      safeExec('node', [
        '--import',
        'scripts/ts-loader.mjs',
        'scripts/mission_controller.ts',
        'create',
        missionId,
        'personal',
        'kyberion',
        'governance',
        '"Ephemeral Secret Mutation"',
        'Unknown',
        '--is-ephemeral',
      ]);
      safeExec('node', [
        '--import',
        'scripts/ts-loader.mjs',
        'scripts/mission_controller.ts',
        'start',
        missionId,
        'personal',
      ]);
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
        changed_keys: [params.account],
      });
      result.mission_id = missionId;
    }
    return result;
  } catch (err: any) {
    return { status: 'failed', error: err?.message ?? String(err) };
  } finally {
    if (isEphemeral) {
      try {
        safeExec('node', [
          '--import',
          'scripts/ts-loader.mjs',
          'scripts/mission_controller.ts',
          'finish',
          missionId,
        ]);
      } catch (err) {
        logger.warn(`Failed to finish ephemeral mission: ${err}`);
      }
    }
  }
}

export async function handleAction(input: SecretAction) {
  const platform = process.platform;
  ensureDefaultOpPreflight();
  const preflight = await runOpPreflight({
    op: `secret:${input.action}`,
    params: input.params || {},
    source: 'actuator',
  });
  if (preflight.decision !== 'allow') {
    throw new Error(
      `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation secret:${input.action} was not admitted.`}`
    );
  }
  const params = preflight.input as SecretAction['params'];

  switch (input.action) {
    case 'get':
      return await getSecret(params, platform);
    case 'set':
      return await withGovernedMutation('set', params, platform, () => setSecret(params, platform));
    case 'delete':
      return await withGovernedMutation('delete', params, platform, () =>
        deleteSecret(params, platform)
      );
    case 'list':
      return listSecrets(params);
    default:
      throw new Error(`Unsupported secret action: ${(input as any).action}`);
  }
}

async function getSecret(params: any, platform: string) {
  try {
    const value = await retry(
      async () => fetchSecret(params.service, params.account),
      buildRetryOptions()
    );
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
    await retry(
      async () => storeSecret(params.service, params.account, params.value),
      buildRetryOptions()
    );
    registryAdd(params.service, params.account);
    return { status: 'success', message: 'Secret stored.' };
  } catch (err: any) {
    return { status: 'failed', error: err.message };
  }
}

async function deleteSecret(params: any, platform: string) {
  if (!params.account) throw new Error('Account is required for "delete" action.');

  try {
    await retry(async () => removeSecret(params.service, params.account), buildRetryOptions());
    registryRemove(params.service, params.account);
    return { status: 'success', message: 'Secret deleted.' };
  } catch (err: any) {
    return { status: 'failed', error: err.message };
  }
}

function listSecrets(params: { service: string }): { status: string; entries: RegistryEntry[] } {
  return coreListSecrets(params.service);
}
