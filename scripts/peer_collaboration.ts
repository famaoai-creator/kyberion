import {
  createStandardYargs,
  decideMeshHubRecipientProposal,
  listMeshHubRecipientProposals,
  logger,
} from '@agent/core';

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .command('list', 'List recipient collaboration proposals', () => undefined)
    .command('accept', 'Accept a pending proposal', () => undefined)
    .command('reject', 'Reject a pending proposal', () => undefined)
    .option('peer-id', { type: 'string', demandOption: true })
    .option('proposal-id', { type: 'string' })
    .option('actor-id', { type: 'string' })
    .option('reason', { type: 'string' })
    .option('status', {
      type: 'string',
      choices: ['pending', 'accepted', 'rejected'],
    })
    .option('mesh-namespace', { type: 'string' })
    .demandCommand(1)
    .parseSync();

  const command = String(argv._[0]);
  const peerId = String(argv['peer-id']);
  const namespace = argv['mesh-namespace'] ? String(argv['mesh-namespace']) : undefined;

  if (command === 'list') {
    const proposals = listMeshHubRecipientProposals(peerId, {
      namespace,
      status: argv.status as 'pending' | 'accepted' | 'rejected' | undefined,
    });
    console.log(JSON.stringify({ peer_id: peerId, proposals }, null, 2));
    return;
  }

  if (command !== 'accept' && command !== 'reject') {
    throw new Error(`Unknown command: ${command}`);
  }
  const proposalId = String(argv['proposal-id'] || '').trim();
  const actorId = String(argv['actor-id'] || '').trim();
  const reason = String(argv.reason || '').trim();
  if (!proposalId || !actorId || !reason) {
    throw new Error(`${command} requires --proposal-id, --actor-id, and --reason`);
  }
  const decision = await decideMeshHubRecipientProposal({
    peerId,
    proposalId,
    decision: command === 'accept' ? 'accepted' : 'rejected',
    actorId,
    reason,
    namespace,
  });
  logger.success(`[peer-collaboration] ${decision.decision} ${decision.proposal_id}`);
  console.log(JSON.stringify({ decision }, null, 2));
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
