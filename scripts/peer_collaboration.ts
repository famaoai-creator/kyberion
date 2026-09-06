import { createStandardYargs } from '@agent/core/cli-utils';
import { getRegisteredEnv } from '@agent/core/foundation/env';
import {
  decideMeshHubRecipientProposal,
  listMeshHubRecipientProposals,
} from '@agent/core/mesh-hub-peer-messaging-adapter';
import { defineScript, isDirectScript, stripSharedScriptFlags } from './lib/harness.js';

function normalizePeerCollaborationArguments(args: string[]): string[] {
  return stripSharedScriptFlags(args);
}

async function main(
  args: string[] = [],
  options: { dryRun?: boolean; check?: boolean } = {}
): Promise<unknown> {
  const argv = await createStandardYargs([
    'node',
    'peer_collaboration',
    ...normalizePeerCollaborationArguments(args),
  ])
    .command('list', 'List recipient collaboration proposals', () => undefined)
    .command('accept', 'Accept a pending proposal', () => undefined)
    .command('reject', 'Reject a pending proposal', () => undefined)
    .option('peer-id', { type: 'string', demandOption: true })
    .option('tenant-id', {
      type: 'string',
      default: (getRegisteredEnv<string>('KYBERION_TENANT_ID') as string | undefined) || '',
      demandOption: true,
    })
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
  const tenantId = String(argv['tenant-id']).trim();
  const namespace = argv['mesh-namespace'] ? String(argv['mesh-namespace']) : undefined;

  if (command === 'list') {
    const proposals = listMeshHubRecipientProposals(peerId, {
      tenantId,
      namespace,
      status: argv.status as 'pending' | 'accepted' | 'rejected' | undefined,
    });
    return { peer_id: peerId, proposals };
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
  if (options.dryRun === true || options.check === true) {
    return {
      dry_run: true,
      operation: command,
      peer_id: peerId,
      tenant_id: tenantId,
      proposal_id: proposalId,
      actor_id: actorId,
      reason,
    };
  }
  const decision = await decideMeshHubRecipientProposal({
    peerId,
    tenantId,
    proposalId,
    decision: command === 'accept' ? 'accepted' : 'rejected',
    actorId,
    reason,
    namespace,
  });
  return { decision };
}

export const runPeerCollaboration = defineScript({
  name: 'peer-collaboration',
  run: async ({ argv, dryRun, check, print }) => {
    const result = await main(argv, { dryRun, check });
    print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'peer_collaboration.ts') ||
  isDirectScript(import.meta.url, 'peer_collaboration.js')
)
  void runPeerCollaboration();
