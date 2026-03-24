import { logger, safeReadFile, safeExec, createStandardYargs, pathResolver, ledger } from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Secret-Actuator v1.0.0 [SOVEREIGN NATIVE BRIDGE]
 * Integrates with OS Native Secret Managers (macOS Keychain, etc.)
 */

interface SecretAction {
  action: 'get' | 'set' | 'delete' | 'list';
  params: {
    account: string;
    service: string;
    value?: string;
    export_as?: string;
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
      safeExec('pnpm', ['tsx', 'scripts/mission_controller.ts', 'create', missionId, 'personal', 'kyberion', 'governance', '"Ephemeral Secret Mutation"', 'Unknown', '--is-ephemeral']);
      safeExec('pnpm', ['tsx', 'scripts/mission_controller.ts', 'start', missionId, 'personal']);
    } catch (err) {
      logger.warn(`Failed to create ephemeral mission: ${err}`);
    }
  }

  // Execute actual secret logic
  const result = await logic();

  if (result.status === 'success') {
    // Record to ledger
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

  if (isEphemeral) {
    try {
      safeExec('pnpm', ['tsx', 'scripts/mission_controller.ts', 'finish', missionId]);
    } catch (err) {
      logger.warn(`Failed to finish ephemeral mission: ${err}`);
    }
  }

  return result;
}

async function handleAction(input: SecretAction) {
  const platform = process.platform;

  switch (input.action) {
    case 'get': return await getSecret(input.params, platform);
    case 'set': 
      return await withGovernedMutation('set', input.params, platform, () => setSecret(input.params, platform));
    case 'delete': 
      return await withGovernedMutation('delete', input.params, platform, () => deleteSecret(input.params, platform));
    default: throw new Error(`Unsupported secret action: ${input.action}`);
  }
}

async function getSecret(params: any, platform: string) {
  if (platform === 'darwin') {
    try {
      // macOS Keychain: security find-generic-password -a <account> -s <service> -w
      const result = safeExec('security', ['find-generic-password', '-a', params.account, '-s', params.service, '-w']).trim();
      return { status: 'success', [params.export_as || 'secret_value']: result };
    } catch (err: any) {
      return { status: 'failed', error: 'Secret not found or access denied.' };
    }
  }
  throw new Error(`Platform ${platform} not supported for 'get' secret yet.`);
}

async function setSecret(params: any, platform: string) {
  if (!params.value) throw new Error('Value is required for "set" action.');
  
  if (platform === 'darwin') {
    try {
      // First try to delete existing to avoid duplicates/errors
      try { safeExec('security', ['delete-generic-password', '-a', params.account, '-s', params.service]); } catch(_) {}
      
      // macOS Keychain: security add-generic-password -a <account> -s <service> -w <value>
      safeExec('security', ['add-generic-password', '-a', params.account, '-s', params.service, '-w', params.value]);
      return { status: 'success', message: 'Secret stored in macOS Keychain.' };
    } catch (err: any) {
      return { status: 'failed', error: err.message };
    }
  }
  throw new Error(`Platform ${platform} not supported for 'set' secret yet.`);
}

async function deleteSecret(params: any, platform: string) {
  if (platform === 'darwin') {
    try {
      safeExec('security', ['delete-generic-password', '-a', params.account, '-s', params.service]);
      return { status: 'success', message: 'Secret deleted from macOS Keychain.' };
    } catch (err: any) {
      return { status: 'failed', error: err.message };
    }
  }
  throw new Error(`Platform ${platform} not supported for 'delete' secret yet.`);
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();
    
  const inputContent = safeReadFile(pathResolver.rootResolve(argv.input as string), { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };
