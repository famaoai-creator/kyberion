/**
 * AA-02: Mesh Hub delivery driver CLI.
 *
 * Default is a single pass (chronos-cron friendly; see
 * pipelines/mesh-delivery.json). `--loop` keeps polling for daemon-style use.
 * Multi-process exclusivity comes from the shared lock below — running two
 * drivers concurrently would turn at-least-once into at-N-times.
 */
import {
  acquireLock,
  releaseLock,
  logger,
  runMeshDeliveryPass,
  formatMeshDeliveryPassReport,
  type MeshDeliveryPassReport,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';

const DRIVER_LOCK_ID = 'mesh-delivery-driver';

async function runOnce(options: {
  senderPeerId: string;
  sharedSecret?: string;
  batchLimit: number;
  json: boolean;
}): Promise<MeshDeliveryPassReport> {
  const report = await runMeshDeliveryPass({
    senderPeerId: options.senderPeerId,
    sharedSecret: options.sharedSecret,
    batchLimit: options.batchLimit,
  });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    logger.info(formatMeshDeliveryPassReport(report));
    for (const failure of report.failures) {
      logger.warn(`[mesh-delivery]   ${failure.delivery_id}: ${failure.reason}`);
    }
  }
  return report;
}

async function main(): Promise<void> {
  const argv = createStandardYargs()
    .option('limit', { type: 'number', default: 10, describe: 'Max deliveries per pass' })
    .option('loop', {
      type: 'boolean',
      default: false,
      describe: 'Keep polling instead of a single pass',
    })
    .option('interval-ms', {
      type: 'number',
      default: 3000,
      describe: 'Idle poll interval in loop mode',
    })
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const senderPeerId = (process.env.KYBERION_MESH_PEER_ID || '').trim();
  if (!senderPeerId) {
    logger.error(
      "[mesh-delivery] KYBERION_MESH_PEER_ID is not set. Set it to this host's peer id from the peer network catalog."
    );
    process.exit(2);
  }
  const sharedSecret = process.env.KYBERION_MESH_SHARED_SECRET || undefined;

  const locked = await acquireLock(DRIVER_LOCK_ID, 1000);
  if (!locked) {
    logger.warn('[mesh-delivery] another driver instance holds the lock; exiting (single-writer).');
    process.exit(0);
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    do {
      const report = await runOnce({
        senderPeerId,
        sharedSecret,
        batchLimit: Number(argv.limit) || 10,
        json: Boolean(argv.json),
      });
      if (!argv.loop) break;
      const idle = report.claimed === 0;
      const delayMs = idle ? Number(argv['interval-ms']) || 3000 : 0;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    } while (!stopping);
  } finally {
    releaseLock(DRIVER_LOCK_ID);
  }
}

const isDirect = process.argv[1] && /mesh_delivery_driver\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
