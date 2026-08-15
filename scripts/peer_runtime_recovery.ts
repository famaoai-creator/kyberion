import {
  createPeerRuntimeRecoveryApprovalRequest,
  createStandardYargs,
  logger,
  resumePeerRuntimeFromQuarantine,
} from '@agent/core';

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .command('request', 'Create a human approval request for quarantined peer runtime')
    .command('resume', 'Resume quarantined peer runtime after approval and heartbeat checks')
    .option('tenant-id', {
      type: 'string',
      default: process.env.KYBERION_TENANT_ID || '',
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
    console.log(
      JSON.stringify(
        {
          approval_id: approval.id,
          approval_channel: approval.storageChannel,
          status: approval.status,
          next: `pnpm cli approve ${approval.id} ${approval.storageChannel}`,
        },
        null,
        2
      )
    );
    return;
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
  logger.success(`[peer-runtime-recovery] resumed ${result.tenant_id}`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
