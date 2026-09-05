import { createStandardYargs } from '@agent/core/cli-utils';
import { getRegisteredEnv } from '@agent/core/foundation/env';
import {
  createPeerRuntimeRecoveryApprovalRequest,
  resumePeerRuntimeFromQuarantine,
} from '@agent/core/peer-runtime-recovery';
import { defineScript, isDirectScript } from './lib/harness.js';

async function main(args: string[] = []) {
  const argv = await createStandardYargs(['node', 'peer_runtime_recovery', ...args])
    .command('request', 'Create a human approval request for quarantined peer runtime')
    .command('resume', 'Resume quarantined peer runtime after approval and heartbeat checks')
    .option('tenant-id', {
      type: 'string',
      default: (getRegisteredEnv<string>('KYBERION_TENANT_ID') as string | undefined) || '',
      demandOption: true,
    })
    .option('quarantine-path', { type: 'string', demandOption: true })
    .option('requested-by', { type: 'string' })
    .option('approval-id', { type: 'string' })
    .option('approval-channel', { type: 'string', default: 'peer-recovery' })
    .demandCommand(1)
    .parseSync();

  const command = String(argv._[0]);
  const tenantId = String(argv['tenant-id']).trim();
  const quarantinePath = String(argv['quarantine-path']).trim();
  if (command === 'request') {
    const requestedBy = String(argv['requested-by'] || '').trim();
    if (!requestedBy) throw new Error('request requires --requested-by');
    const approval = createPeerRuntimeRecoveryApprovalRequest({
      tenantId,
      quarantinePath,
      requestedBy,
      approvalChannel: String(argv['approval-channel']),
    });
    return {
      approval_id: approval.id,
      approval_channel: approval.storageChannel,
      status: approval.status,
      next: `pnpm kyberion approve ${approval.id} ${approval.storageChannel}`,
    };
  }
  if (command !== 'resume') throw new Error(`Unknown command: ${command}`);
  const approvalId = String(argv['approval-id'] || '').trim();
  if (!approvalId) throw new Error('resume requires --approval-id');
  const result = resumePeerRuntimeFromQuarantine({
    tenantId,
    quarantinePath,
    approvalRequestId: approvalId,
    approvalChannel: String(argv['approval-channel']),
  });
  return result;
}

export const runPeerRuntimeRecovery = defineScript({
  name: 'peer:runtime-recovery',
  flags: [],
  run: async ({ argv, print }) => {
    const result = await main(argv);
    print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'peer_runtime_recovery.ts') ||
  isDirectScript(import.meta.url, 'peer_runtime_recovery.js')
)
  void runPeerRuntimeRecovery();
