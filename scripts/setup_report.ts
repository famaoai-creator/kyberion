import { createStandardYargs } from '@agent/core/cli-utils';
import { logger } from '@agent/core';
import { setupSurfaces } from './surface_runtime.js';
import { setupServices } from './services_setup.js';
import { runReasoningSetup } from './reasoning_setup.js';
import { collectDoctorReport } from './run_doctor.js';
import { formatSetupSummaryLine } from './setup-report.js';

export async function runSetupReport(): Promise<{
  surfaces: Awaited<ReturnType<typeof setupSurfaces>>;
  services: Awaited<ReturnType<typeof setupServices>>;
  reasoning: { must: number; should: number; nice: number };
  doctor: Awaited<ReturnType<typeof collectDoctorReport>>;
}> {
  const surfaces = await setupSurfaces();
  const services = await setupServices();
  const reasoning = await runReasoningSetup();
  const doctor = await collectDoctorReport({});

  return { surfaces, services, reasoning, doctor };
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const report = await runSetupReport();

  console.log('');
  console.log(formatSetupSummaryLine([
    ['surface issues', report.surfaces.summary.missing],
    ['service auth missing', report.services.summary.authMissing],
    ['service connections missing', report.services.summary.connectionMissing],
    ['reasoning must', report.reasoning.must],
    ['reasoning should', report.reasoning.should],
    ['doctor must', report.doctor.totalMissing],
  ]));

  if (report.doctor.summaries.length > 0) {
    console.log('Doctor detail:');
    for (const summary of report.doctor.summaries) {
      console.log(`  - ${summary.manifestId}`);
      for (const line of summary.lines) {
        console.log(`    ${line}`);
      }
    }
  }

  if (argv.json) {
    logger.info(JSON.stringify({ status: 'ok', report }, null, 2));
  }
}

const isDirect = process.argv[1] && /setup_report\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    logger.error(err?.message ?? String(err));
    process.exit(1);
  });
}
