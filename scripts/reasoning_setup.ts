import {
  loadEnvironmentManifest,
  logger,
  probeManifest,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { formatDoctorSummary, summarizeManifestDoctor } from './environment-doctor.js';
import { formatSetupSummaryLine } from './setup-report.js';

import '@agent/core/environment-capability-probes';

export async function runReasoningSetup(): Promise<{ must: number; should: number; nice: number }> {
  const manifest = loadEnvironmentManifest('reasoning-backend');
  const probeStatuses = await probeManifest(manifest);
  const summary = summarizeManifestDoctor(manifest, probeStatuses);

  logger.info('');
  logger.info(formatSetupSummaryLine([
    ['must', summary.counts.must],
    ['should', summary.counts.should],
    ['nice', summary.counts.nice],
  ]));
  for (const line of formatDoctorSummary(summary)) {
    logger.info(line);
  }
  logger.info('');

  return summary.counts;
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const counts = await runReasoningSetup();
  if (argv.json) {
    logger.info(JSON.stringify({ status: 'ok', counts }, null, 2));
  }

  process.exit(counts.must === 0 && counts.should === 0 ? 0 : 1);
}

const isDirect = process.argv[1] && /reasoning_setup\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    logger.error(err?.message ?? String(err));
    process.exit(1);
  });
}
