import { createStandardYargs } from '@agent/core/cli-utils';
import {
  decidePeerTask,
  deliverPeerTaskResult,
  getPeerTask,
  listPeerTasks,
  loadPeerTaskCatalog,
  proposePeerTask,
  resendPeerTaskProposal,
  resumePeerTask,
  type PeerTaskDirection,
  type PeerTaskState,
} from '@agent/core/mesh/peer-task-exchange';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { defineScript, isDirectScript, stripSharedScriptFlags } from './lib/harness.js';

function required(value: unknown, flag: string, command: string): string {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${command} requires --${flag}`);
  return text;
}

async function main(
  args: string[] = [],
  options: { dryRun?: boolean; check?: boolean } = {}
): Promise<unknown> {
  const argv = await createStandardYargs(['node', 'peer_task', ...stripSharedScriptFlags(args)])
    .command(
      'propose',
      'Propose a typed task to a peer (the peer accepts it locally)',
      () => undefined
    )
    .command('list', 'List inbound / outbound peer tasks', () => undefined)
    .command('show', 'Show one peer task', () => undefined)
    .command(
      'offered',
      'List the task types this peer offers (local task catalog)',
      () => undefined
    )
    .command(
      'accept',
      'Accept a pending inbound task: run it as a WorkItem and send the result',
      () => undefined
    )
    .command('reject', 'Reject a pending inbound task and tell the proposer', () => undefined)
    .command(
      'resend-proposal',
      'Resend a pending outbound proposal with its original task id',
      () => undefined
    )
    .command(
      'resume',
      'Resume an accepted inbound task that stopped before its result',
      () => undefined
    )
    .command('resend-result', 'Resend the stored result of an inbound task', () => undefined)
    .option('peer-id', { type: 'string', demandOption: true, description: 'This Kyberion peer id' })
    .option('tenant-id', {
      type: 'string',
      default: getRegisteredEnvText('KYBERION_TENANT_ID') || '',
    })
    .option('to-peer', { type: 'string', description: 'propose: recipient peer id' })
    .option('task-type', {
      type: 'string',
      description: 'propose: a task type the recipient offers',
    })
    .option('summary', { type: 'string', description: 'propose: why the task is needed' })
    .option('session-id', { type: 'string' })
    .option('ttl-ms', { type: 'number', description: 'propose: proposal lifetime (default 24h)' })
    .option('task-id', { type: 'string' })
    .option('direction', { type: 'string', choices: ['inbound', 'outbound'] })
    .option('state', {
      type: 'string',
      choices: ['pending', 'accepted', 'running', 'completed', 'failed', 'rejected', 'expired'],
    })
    .option('actor-id', { type: 'string', description: 'accept/reject: who decided' })
    .option('reason', { type: 'string', description: 'accept/reject: why' })
    .option('force', {
      type: 'boolean',
      default: false,
      description: 'resume: take over a task whose runner passed its deadline',
    })
    .option('timeout-ms', { type: 'number', default: 10_000 })
    .demandCommand(1)
    .parseSync();

  const command = String(argv._[0]);
  const peerId = String(argv['peer-id']).trim();
  const tenantId = String(argv['tenant-id'] || '').trim();
  if (!tenantId) throw new Error('Missing tenant id. Set KYBERION_TENANT_ID or pass --tenant-id.');
  const previewOnly = options.dryRun === true || options.check === true;

  switch (command) {
    case 'propose': {
      const input = {
        tenantId,
        senderPeerId: peerId,
        recipientPeerId: required(argv['to-peer'], 'to-peer', command),
        taskType: required(argv['task-type'], 'task-type', command),
        summary: required(argv.summary, 'summary', command),
        ...(argv['session-id'] ? { sessionId: String(argv['session-id']) } : {}),
        ...(argv['ttl-ms'] !== undefined ? { ttlMs: Number(argv['ttl-ms']) } : {}),
        timeoutMs: Number(argv['timeout-ms']),
      };
      if (previewOnly) return { dry_run: true, operation: 'peer-task.propose', ...input };
      return proposePeerTask(input);
    }
    case 'list':
      return {
        peer_id: peerId,
        tasks: listPeerTasks(tenantId, peerId, {
          ...(argv.direction ? { direction: argv.direction as PeerTaskDirection } : {}),
          ...(argv.state ? { state: argv.state as PeerTaskState } : {}),
        }),
      };
    case 'show': {
      const taskId = required(argv['task-id'], 'task-id', command);
      return {
        inbound: getPeerTask(tenantId, peerId, 'inbound', taskId),
        outbound: getPeerTask(tenantId, peerId, 'outbound', taskId),
      };
    }
    case 'offered':
      return { peer_id: peerId, catalog: loadPeerTaskCatalog(tenantId) };
    case 'accept':
    case 'reject': {
      const input = {
        tenantId,
        localPeerId: peerId,
        taskId: required(argv['task-id'], 'task-id', command),
        decision: command === 'accept' ? ('accepted' as const) : ('rejected' as const),
        actorId: required(argv['actor-id'], 'actor-id', command),
        reason: required(argv.reason, 'reason', command),
      };
      if (previewOnly) return { dry_run: true, operation: `peer-task.${command}`, ...input };
      return decidePeerTask(input);
    }
    case 'resend-proposal': {
      const taskId = required(argv['task-id'], 'task-id', command);
      if (previewOnly)
        return { dry_run: true, operation: 'peer-task.resend-proposal', task_id: taskId };
      return resendPeerTaskProposal({
        tenantId,
        localPeerId: peerId,
        taskId,
        timeoutMs: Number(argv['timeout-ms']),
      });
    }
    case 'resume': {
      const taskId = required(argv['task-id'], 'task-id', command);
      if (previewOnly) return { dry_run: true, operation: 'peer-task.resume', task_id: taskId };
      return resumePeerTask({ tenantId, localPeerId: peerId, taskId, force: argv.force === true });
    }
    case 'resend-result': {
      const taskId = required(argv['task-id'], 'task-id', command);
      if (previewOnly)
        return { dry_run: true, operation: 'peer-task.resend-result', task_id: taskId };
      return deliverPeerTaskResult({ tenantId, localPeerId: peerId, taskId });
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

export const runPeerTask = defineScript({
  name: 'peer:task',
  run: async ({ argv, dryRun, check, print }) => {
    const result = await main(argv, { dryRun, check });
    print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'peer_task.ts') ||
  isDirectScript(import.meta.url, 'peer_task.js')
)
  void runPeerTask();
