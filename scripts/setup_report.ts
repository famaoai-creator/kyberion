import { createStandardYargs } from '@agent/core/cli-utils';
import { buildNextAction, formatNextAction } from '@agent/core/next-action';
import { setupSurfaces } from './surface_runtime.js';
import { setupServices } from './services_setup.js';
import { runReasoningSetup } from './reasoning_setup.js';
import { collectDoctorReport } from './run_doctor.js';
import { defineScript, isDirectScript } from './lib/harness.js';
import { formatSetupSummaryLine } from './setup-report-format.js';
export {
  formatSetupHintLine,
  formatSetupSummaryLine,
  type SetupCountEntry,
} from './setup-report-format.js';

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
  quiet?: boolean;
}): Promise<SetupReport> {
  const quiet = options.quiet ?? options.persona === 'first-time-user';
  const surfaces = await setupSurfaces({ quiet });
  const services = await setupServices({ quiet });
  const reasoning = await runReasoningSetup({ quiet });
  const doctor = await collectDoctorReport({});
  const recommendedSurfaces = buildRecommendedSurfaces({ surfaces, doctor });

  const nextActions = buildFirstTimeUserNextActions({ surfaces, services, doctor });

  return { surfaces, services, reasoning, doctor, recommendedSurfaces, nextActions };
}

function buildFirstTimeUserNextActions(
  report: Pick<SetupReport, 'surfaces' | 'services' | 'doctor'>
): Array<ReturnType<typeof buildNextAction>> {
  const actions: Array<ReturnType<typeof buildNextAction>> = [];
  if (report.surfaces.summary.missing > 0 || report.surfaces.summary.disabled > 0) {
    actions.push(
      buildNextAction({
        title: 'Reconcile surface readiness',
        reason: `${report.surfaces.summary.missing} surface auth gaps and ${report.surfaces.summary.disabled} disabled surfaces need attention.`,
        next_action_type: 'run_command',
        suggested_command: 'pnpm surfaces reconcile',
      })
    );
  }
  if (report.services.summary.authMissing > 0 || report.services.summary.connectionMissing > 0) {
    actions.push(
      buildNextAction({
        title: 'Repair service setup',
        reason: `${report.services.summary.authMissing} services are missing auth and ${report.services.summary.connectionMissing} are missing connections.`,
        next_action_type: 'bootstrap_environment',
        suggested_command: 'pnpm services:setup',
      })
    );
  }
  const doctorSummary = report.doctor.summaries.find(
    (summary) => summary.counts.must + summary.counts.should > 0
  );
  if (doctorSummary) {
    actions.push(
      buildNextAction({
        title: `Bootstrap ${doctorSummary.manifestId}`,
        reason: `Doctor reports ${doctorSummary.counts.must} must and ${doctorSummary.counts.should} should gaps.`,
        next_action_type: 'bootstrap_environment',
        suggested_command: `pnpm env:bootstrap --manifest ${doctorSummary.manifestId} --apply`,
      })
    );
  }
  if (actions.length === 0) {
    actions.push(
      buildNextAction({
        title: 'Re-run setup report after changes',
        reason: 'Everything looks ready right now.',
        next_action_type: 'inspect_artifact',
        suggested_command: 'pnpm kyberion setup report',
      })
    );
  }
  return actions.slice(0, 4);
}

function buildRecommendedSurfaces(
  report: Pick<SetupReport, 'surfaces' | 'doctor'>
): SurfaceRecommendation[] {
  const rows = report.surfaces.rows || [];
  const rowById = new Map(rows.map((row: any) => [row.surface, row]));
  const doctorByManifest = new Map(
    report.doctor.summaries.map((summary) => [summary.manifestId, summary])
  );

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
      ? meetingDoctor && meetingDoctor.counts.must + meetingDoctor.counts.should > 0
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
      whenToUse:
        'Open this first when you want to see what Kyberion is running and which runtime needs attention.',
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
            ? 'pnpm surfaces reconcile'
            : 'pnpm surfaces status',
    },
    {
      id: 'voice-first-win',
      title: 'Presence Studio + voice path',
      whenToUse:
        'Use this when you want a conversational surface with transcript and browser/voice feedback.',
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
            : 'pnpm surfaces status',
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
          ? 'pnpm surfaces start --surface slack-bridge'
          : messagingReadiness === 'needs_setup'
            ? 'pnpm surfaces setup'
            : 'pnpm surfaces status',
    },
  ];
}

function formatSetupReport(report: SetupReport, persona: SetupPersona): string {
  const lines = [
    '',
    formatSetupSummaryLine([
      ['surface issues', report.surfaces.summary.missing],
      ['service auth missing', report.services.summary.authMissing],
      ['service connections missing', report.services.summary.connectionMissing],
      ['reasoning must', report.reasoning.must],
      ['reasoning should', report.reasoning.should],
      ['doctor must', report.doctor.totalMissing],
    ]),
  ];

  if (persona === 'first-time-user') {
    lines.push('Recommended surfaces:');
    for (const surface of report.recommendedSurfaces) {
      lines.push(`- ${surface.title} [${surface.readiness}]`);
      lines.push(`  use when: ${surface.whenToUse}`);
      lines.push(`  surfaces: ${surface.surfaces.join(', ')}`);
      lines.push(`  why now: ${surface.reason}`);
      lines.push(`  try: ${surface.suggestedCommand}`);
    }
    lines.push('', 'First-time user next actions:');
    for (const action of report.nextActions) lines.push(...formatNextAction(action));
  } else if (report.doctor.summaries.length > 0) {
    lines.push('Doctor detail:');
    for (const summary of report.doctor.summaries) {
      lines.push(`  - ${summary.manifestId}`);
      lines.push(...summary.lines.map((line) => `    ${line}`));
    }
  }

  return lines.join('\n');
}

async function main(
  args: string[] = [],
  quiet = false
): Promise<{ report: SetupReport; persona: SetupPersona }> {
  const normalizedArgs = args.filter((arg) => arg !== '--');
  const argv = await createStandardYargs(['node', 'setup_report', ...normalizedArgs])
    .option('persona', {
      type: 'string',
      choices: ['operator', 'first-time-user'] as const,
      default: 'operator',
    })
    .parseSync();

  const report = await runSetupReportWithPersona({ persona: argv.persona as SetupPersona, quiet });
  return { report, persona: argv.persona as SetupPersona };
}

export const runSetupReportCli = defineScript({
  name: 'setup:report',
  run: async ({ argv, json, quiet, print }) => {
    const result = await main(argv, quiet || json);
    print(
      json
        ? { status: 'ok', report: result.report }
        : formatSetupReport(result.report, result.persona)
    );
    return result.report;
  },
});

if (
  isDirectScript(import.meta.url, 'setup_report.ts') ||
  isDirectScript(import.meta.url, 'setup_report.js')
)
  void runSetupReportCli();
