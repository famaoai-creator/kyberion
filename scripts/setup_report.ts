import { createStandardYargs } from '@agent/core/cli-utils';
import { buildNextAction, formatNextAction, logger } from '@agent/core';
import { setupSurfaces } from './surface_runtime.js';
import { setupServices } from './services_setup.js';
import { runReasoningSetup } from './reasoning_setup.js';
import { collectDoctorReport } from './run_doctor.js';
import { formatSetupSummaryLine } from './setup-report.js';

type SetupPersona = 'operator' | 'first-time-user';

type SetupReport = {
  surfaces: Awaited<ReturnType<typeof setupSurfaces>>;
  services: Awaited<ReturnType<typeof setupServices>>;
  reasoning: { must: number; should: number; nice: number };
  doctor: Awaited<ReturnType<typeof collectDoctorReport>>;
  nextActions: ReturnType<typeof buildNextAction>[];
};

export async function runSetupReport(): Promise<SetupReport> {
  return runSetupReportWithPersona({});
}

export async function runSetupReportWithPersona(options: {
  persona?: SetupPersona;
}): Promise<SetupReport> {
  const quiet = options.persona === 'first-time-user';
  const surfaces = await setupSurfaces({ quiet });
  const services = await setupServices({ quiet });
  const reasoning = await runReasoningSetup();
  const doctor = await collectDoctorReport({});

  const nextActions = buildFirstTimeUserNextActions({ surfaces, services, doctor });

  return { surfaces, services, reasoning, doctor, nextActions };
}

function buildFirstTimeUserNextActions(report: SetupReport): Array<ReturnType<typeof buildNextAction>> {
  const actions: Array<ReturnType<typeof buildNextAction>> = [];
  if (report.surfaces.summary.missing > 0 || report.surfaces.summary.disabled > 0) {
    actions.push(buildNextAction({
      title: 'Reconcile surface readiness',
      reason: `${report.surfaces.summary.missing} surface auth gaps and ${report.surfaces.summary.disabled} disabled surfaces need attention.`,
      next_action_type: 'run_command',
      suggested_command: 'pnpm surfaces:reconcile',
    }));
  }
  if (report.services.summary.authMissing > 0 || report.services.summary.connectionMissing > 0) {
    actions.push(buildNextAction({
      title: 'Repair service setup',
      reason: `${report.services.summary.authMissing} services are missing auth and ${report.services.summary.connectionMissing} are missing connections.`,
      next_action_type: 'bootstrap_environment',
      suggested_command: 'pnpm services:setup',
    }));
  }
  const doctorSummary = report.doctor.summaries.find((summary) => summary.counts.must + summary.counts.should > 0);
  if (doctorSummary) {
    actions.push(buildNextAction({
      title: `Bootstrap ${doctorSummary.manifestId}`,
      reason: `Doctor reports ${doctorSummary.counts.must} must and ${doctorSummary.counts.should} should gaps.`,
      next_action_type: 'bootstrap_environment',
      suggested_command: `pnpm env:bootstrap --manifest ${doctorSummary.manifestId} --apply`,
    }));
  }
  if (actions.length === 0) {
    actions.push(buildNextAction({
      title: 'Re-run setup report after changes',
      reason: 'Everything looks ready right now.',
      next_action_type: 'inspect_artifact',
      suggested_command: 'pnpm setup:report',
    }));
  }
  return actions.slice(0, 4);
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
    console.log('First-time user next actions:');
    for (const action of report.nextActions) {
      for (const line of formatNextAction(action)) {
        console.log(line);
      }
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
