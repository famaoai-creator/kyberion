/**
 * AA-02: Mesh Hub delivery driver CLI.
 *
 * Default is a single pass (chronos-cron friendly; see
 * pipelines/mesh-delivery.json). `--loop` keeps polling for daemon-style use.
 * Multi-process exclusivity comes from the shared lock below — running two
 * drivers concurrently would turn at-least-once into at-N-times.
 */
import {
  runMeshDeliveryPass,
  formatMeshDeliveryPassReport,
  type MeshDeliveryPassReport,
} from '@agent/core/mesh-delivery-driver';
import { acquireLock, releaseLock } from '@agent/core/lock-utils';
import { logger } from '@agent/core/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const DRIVER_LOCK_ID = 'mesh-delivery-driver';
type Print = (value: unknown) => void;

interface MeshDeliveryDriverOnceOptions {
  senderPeerId: string;
  sharedSecret?: string;
  batchLimit: number;
  json: boolean;
  print?: Print;
}

export async function runMeshDeliveryDriverOnce(
  options: MeshDeliveryDriverOnceOptions
): Promise<MeshDeliveryPassReport> {
  const report = await runMeshDeliveryPass({
    senderPeerId: options.senderPeerId,
    sharedSecret: options.sharedSecret,
    batchLimit: options.batchLimit,
  });
  if (options.json) {
    if (options.print) options.print(report);
    else logger.info(JSON.stringify(report, null, 2));
  } else {
    const print = options.print ?? ((value: unknown) => logger.info(String(value)));
    print(formatMeshDeliveryPassReport(report));
    for (const failure of report.failures) {
      print(`[mesh-delivery]   ${failure.delivery_id}: ${failure.reason}`);
    }
  }
  return report;
}

export async function main(args: string[] = [], print: Print = () => undefined): Promise<void> {
  const argv = createStandardYargs(['node', 'mesh_delivery_driver', ...args])
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

  const senderPeerId = (getRegisteredEnvText('KYBERION_MESH_PEER_ID') || '').trim();
  if (!senderPeerId) {
    throw new ScriptExitError(
      2,
      "[mesh-delivery] KYBERION_MESH_PEER_ID is not set. Set it to this host's peer id from the peer network catalog."
    );
  }
  const sharedSecret = getRegisteredEnvText('KYBERION_MESH_SHARED_SECRET') || undefined;

  const locked = await acquireLock(DRIVER_LOCK_ID, 1000);
  if (!locked) {
    logger.warn('[mesh-delivery] another driver instance holds the lock; exiting (single-writer).');
    return;
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    do {
      const report = await runMeshDeliveryDriverOnce({
        senderPeerId,
        sharedSecret,
        batchLimit: Number(argv.limit) || 10,
        json: Boolean(argv.json),
        print,
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

export const runMeshDeliveryDriver = defineScript({
  name: 'mesh:delivery-driver',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});

if (
  isDirectScript(import.meta.url, 'mesh_delivery_driver.ts') ||
  isDirectScript(import.meta.url, 'mesh_delivery_driver.js')
)
  void runMeshDeliveryDriver();
