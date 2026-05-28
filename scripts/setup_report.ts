import { createStandardYargs } from '@agent/core/cli-utils';
import { logger } from '@agent/core';
import { setupSurfaces } from './surface_runtime.js';
import { setupServices } from './services_setup.js';
import { runReasoningSetup } from './reasoning_setup.js';
import { collectDoctorReport } from './run_doctor.js';
import { formatSetupHintLine, formatSetupSummaryLine } from './setup-report.js';

type SetupPersona = 'operator' | 'first-time-user';

export async function runSetupReport(): Promise<{
  surfaces: Awaited<ReturnType<typeof setupSurfaces>>;
  services: Awaited<ReturnType<typeof setupServices>>;
  reasoning: { must: number; should: number; nice: number };
  doctor: Awaited<ReturnType<typeof collectDoctorReport>>;
}> {
  return runSetupReportWithPersona({});
}

export async function runSetupReportWithPersona(options: {
  persona?: SetupPersona;
}): Promise<{
  surfaces: Awaited<ReturnType<typeof setupSurfaces>>;
  services: Awaited<ReturnType<typeof setupServices>>;
  reasoning: { must: number; should: number; nice: number };
  doctor: Awaited<ReturnType<typeof collectDoctorReport>>;
}> {
  const quiet = options.persona === 'first-time-user';
  const surfaces = await setupSurfaces({ quiet });
  const services = await setupServices({ quiet });
  const reasoning = await runReasoningSetup();
  const doctor = await collectDoctorReport({});

  return { surfaces, services, reasoning, doctor };
}

function buildFirstTimeUserHints(report: Awaited<ReturnType<typeof runSetupReportWithPersona>>): string[] {
  const hints: string[] = [];
  if (report.surfaces.summary.missing > 0) {
    hints.push(formatSetupHintLine('Run `pnpm surfaces:setup` to inspect missing surface auth and enablement.'));
  }
  if (report.surfaces.summary.missing > 0 || report.surfaces.summary.disabled > 0) {
    hints.push(formatSetupHintLine('Run `pnpm surfaces:reconcile` after fixing any surface auth or manifest issues.'));
  }
  if (report.services.summary.authMissing > 0 || report.services.summary.connectionMissing > 0) {
    hints.push(formatSetupHintLine('See `docs/user/TROUBLESHOOTING.md` for service auth and connection recovery steps.'));
  }
  if (report.doctor.totalMissing > 0) {
    hints.push(formatSetupHintLine('Run `pnpm doctor` for the canonical readiness gate.'));
  }
  if (hints.length === 0) {
    hints.push(formatSetupHintLine('Everything looks ready. Re-run `pnpm setup:report` after you make changes.'));
  }
  return hints.slice(0, 4);
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('json', { type: 'boolean', default: false })
    .option('persona', {
      type: 'string',
      choices: ['operator', 'first-time-user'] as const,
      default: 'operator',
    })
    .parseSync();

  const report = await runSetupReportWithPersona({ persona: argv.persona as SetupPersona });

  console.log('');
  console.log(formatSetupSummaryLine([
    ['surface issues', report.surfaces.summary.missing],
    ['service auth missing', report.services.summary.authMissing],
    ['service connections missing', report.services.summary.connectionMissing],
    ['reasoning must', report.reasoning.must],
    ['reasoning should', report.reasoning.should],
    ['doctor must', report.doctor.totalMissing],
  ]));

  if (argv.persona === 'first-time-user') {
    console.log('First-time user next steps:');
    for (const hint of buildFirstTimeUserHints(report)) {
      console.log(hint);
    }
  } else if (report.doctor.summaries.length > 0) {
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
