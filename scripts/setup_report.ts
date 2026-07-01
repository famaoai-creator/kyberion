import { createStandardYargs } from '@agent/core/cli-utils';
import { buildNextAction, formatNextAction, logger } from '@agent/core';
import { setupSurfaces } from './surface_runtime.js';
import { setupServices } from './services_setup.js';
import { runReasoningSetup } from './reasoning_setup.js';
import { collectDoctorReport } from './run_doctor.js';
import { formatSetupSummaryLine } from './setup-report.js';

type SetupPersona = 'operator' | 'first-time-user';

type SurfaceRecommendation = {
  id: 'chronos' | 'voice-first-win' | 'messaging';
  title: string;
  whenToUse: string;
  surfaces: string[];
  readiness: 'ready' | 'needs_setup' | 'unavailable';
  reason: string;
  suggestedCommand: string;
};

type SetupReport = {
  surfaces: Awaited<ReturnType<typeof setupSurfaces>>;
  services: Awaited<ReturnType<typeof setupServices>>;
  reasoning: { must: number; should: number; nice: number };
  doctor: Awaited<ReturnType<typeof collectDoctorReport>>;
  recommendedSurfaces: SurfaceRecommendation[];
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
  const recommendedSurfaces = buildRecommendedSurfaces({ surfaces, doctor });

  const nextActions = buildFirstTimeUserNextActions({ surfaces, services, doctor });

  return { surfaces, services, reasoning, doctor, recommendedSurfaces, nextActions };
}

function buildFirstTimeUserNextActions(report: Pick<SetupReport, 'surfaces' | 'services' | 'doctor'>): Array<ReturnType<typeof buildNextAction>> {
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

function buildRecommendedSurfaces(report: Pick<SetupReport, 'surfaces' | 'doctor'>): SurfaceRecommendation[] {
  const rows = report.surfaces.rows || [];
  const rowById = new Map(rows.map((row: any) => [row.surface, row]));
  const doctorByManifest = new Map(report.doctor.summaries.map((summary) => [summary.manifestId, summary]));

  const chronos = rowById.get('chronos-mirror-v2');
  const voiceHub = rowById.get('voice-hub');
  const presenceStudio = rowById.get('presence-studio');
  const slack = rowById.get('slack-bridge');
  const meetingDoctor = doctorByManifest.get('meeting-participation-runtime');

  const chronosReadiness: SurfaceRecommendation['readiness'] =
    chronos?.enabled === 'enabled'
      ? chronos.auth === 'missing'
        ? 'needs_setup'
        : 'ready'
      : 'unavailable';

  const voiceReadiness: SurfaceRecommendation['readiness'] =
    voiceHub?.enabled === 'enabled' && presenceStudio?.enabled === 'enabled'
      ? meetingDoctor && (meetingDoctor.counts.must + meetingDoctor.counts.should > 0)
        ? 'needs_setup'
        : 'ready'
      : 'unavailable';

  const messagingReadiness: SurfaceRecommendation['readiness'] =
    slack?.enabled === 'enabled'
      ? slack.auth === 'ready'
        ? 'ready'
        : 'needs_setup'
      : 'unavailable';

  return [
    {
      id: 'chronos',
      title: 'Chronos control surface',
      whenToUse: 'Open this first when you want to see what Kyberion is running and which runtime needs attention.',
      surfaces: ['chronos-mirror-v2'],
      readiness: chronosReadiness,
      reason:
        chronosReadiness === 'ready'
          ? 'The local control UI is enabled, so this is the best entry point for system visibility.'
          : chronosReadiness === 'needs_setup'
            ? 'The control UI exists, but surface readiness still needs setup or repair before it is trustworthy.'
            : 'The control UI is disabled in the current manifest, so this is not your immediate first surface.',
      suggestedCommand:
        chronosReadiness === 'ready'
          ? 'pnpm chronos:dev'
          : chronosReadiness === 'needs_setup'
            ? 'pnpm surfaces:reconcile'
            : 'pnpm surfaces:status',
    },
    {
      id: 'voice-first-win',
      title: 'Presence Studio + voice path',
      whenToUse: 'Use this when you want a conversational surface with transcript and browser/voice feedback.',
      surfaces: ['presence-studio', 'voice-hub'],
      readiness: voiceReadiness,
      reason:
        voiceReadiness === 'ready'
          ? 'The voice surfaces are enabled and doctor did not report meeting/browser runtime gaps.'
          : voiceReadiness === 'needs_setup'
            ? 'The voice surfaces exist, but doctor still sees browser, voice, or consent gaps that will block the first voice win.'
            : 'The required voice surfaces are not all enabled right now.',
      suggestedCommand:
        voiceReadiness === 'ready'
          ? 'pnpm pipeline --input pipelines/voice-hello.json'
          : voiceReadiness === 'needs_setup'
            ? 'pnpm doctor --runtime browser'
            : 'pnpm surfaces:status',
    },
    {
      id: 'messaging',
      title: 'Slack thread surface',
      whenToUse: 'Use this when you want remote, threaded conversation and follow-up in Slack.',
      surfaces: ['slack-bridge'],
      readiness: messagingReadiness,
      reason:
        messagingReadiness === 'ready'
          ? 'Slack auth is ready, so Kyberion can accept and return work in the same thread.'
          : messagingReadiness === 'needs_setup'
            ? 'Slack is the right messaging surface, but its auth is not ready yet.'
            : 'Slack is disabled, so messaging work should stay in terminal or Chronos for now.',
      suggestedCommand:
        messagingReadiness === 'ready'
          ? 'pnpm surfaces:start --surface slack-bridge'
          : messagingReadiness === 'needs_setup'
            ? 'pnpm surfaces:setup'
            : 'pnpm surfaces:status',
    },
  ];
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
    console.log('Recommended surfaces:');
    for (const surface of report.recommendedSurfaces) {
      console.log(`- ${surface.title} [${surface.readiness}]`);
      console.log(`  use when: ${surface.whenToUse}`);
      console.log(`  surfaces: ${surface.surfaces.join(', ')}`);
      console.log(`  why now: ${surface.reason}`);
      console.log(`  try: ${surface.suggestedCommand}`);
    }
    console.log('');
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
