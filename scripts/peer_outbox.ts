import { createStandardYargs } from '@agent/core/cli-utils';
import {
  runPeerOutboxRedeliveryPass,
  summarizePeerOutbox,
} from '@agent/core/mesh/peer-outbox-redelivery';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { defineScript, isDirectScript, stripSharedScriptFlags } from './lib/harness.js';

export async function main(
  args: string[] = [],
  options: { dryRun?: boolean; check?: boolean } = {}
): Promise<unknown> {
  const argv = await createStandardYargs(['node', 'peer_outbox', ...stripSharedScriptFlags(args)])
    .command(
      'status',
      'Show the delivery state of sent peer messages: pending retries, refused and given up',
      () => undefined
    )
    .command(
      'redeliver',
      'Run one redelivery pass: re-send retryable failed messages that are due',
      () => undefined
    )
    .option('peer-id', { type: 'string', demandOption: true, description: 'This Kyberion peer id' })
    .option('tenant-id', {
      type: 'string',
      default: getRegisteredEnvText('KYBERION_TENANT_ID') || '',
      description: 'Tenant of the peer runtime',
    })
    .demandCommand(1)
    .parseSync();

  const command = String(argv._[0]);
  const peerId = String(argv['peer-id']).trim();
  const tenantId = String(argv['tenant-id'] || '').trim();
  if (!tenantId) throw new Error('Missing tenant id. Set KYBERION_TENANT_ID or pass --tenant-id.');

  if (command === 'status') return summarizePeerOutbox(tenantId, peerId);
  if (command !== 'redeliver') throw new Error(`Unknown command: ${command}`);
  if (options.dryRun === true || options.check === true) {
    return {
      dry_run: true,
      operation: 'peer-outbox.redeliver',
      ...summarizePeerOutbox(tenantId, peerId),
    };
  }
  const pass = await runPeerOutboxRedeliveryPass({ tenantId, peerId });
  return { pass, outbox: summarizePeerOutbox(tenantId, peerId) };
}

export const runPeerOutbox = defineScript({
  name: 'peer:outbox',
  run: async ({ argv, dryRun, check, print }) => {
    const result = await main(argv, { dryRun, check });
    print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'peer_outbox.ts') ||
  isDirectScript(import.meta.url, 'peer_outbox.js')
)
  void runPeerOutbox();
