import { createStandardYargs } from '@agent/core/cli-utils';
import { buildNextAction, formatNextAction } from '@agent/core/next-action';
import {
  loadSurfaceManifest,
  probeSurfaceHealth,
  type SurfaceHealthStatus,
  type SurfaceRuntimeDefinition,
} from '@agent/core/surface/surface-runtime';
import { setupSurfaces } from './surface_runtime.js';
import { setupServices } from './services_setup.js';
import { runReasoningSetup } from './reasoning_setup.js';
import { collectDoctorReport } from './run_doctor.js';
import { buildVitalReport } from './vital_check.js';
import { defineScript, isDirectScript } from './lib/harness.js';
import { formatSetupSummaryLine } from './setup-report-format.js';
export {
  formatSetupHintLine,
  formatSetupSummaryLine,
  type SetupCountEntry,
} from './setup-report-format.js';

type SetupPersona = 'operator' | 'first-time-user';
type NextAction = ReturnType<typeof buildNextAction>;

export type SetupSurfaceHealth = SurfaceHealthStatus & { url?: string };

export type SurfaceRecommendation = {
  id: 'concierge' | 'chronos' | 'voice-first-win' | 'messaging';
  title: string;
  whenToUse: string;
  surfaces: string[];
  optional: boolean;
  readiness: 'ready' | 'needs_setup' | 'needs_attention' | 'unavailable' | 'unverified';
  reason: string;
  suggestedCommand?: string;
  openUrl?: string;
  nextAction: NextAction;
};

type SetupReport = {
  surfaces: Awaited<ReturnType<typeof setupSurfaces>>;
  surfaceHealth: Record<string, SetupSurfaceHealth>;
  services: Awaited<ReturnType<typeof setupServices>>;
  reasoning: { must: number; should: number; nice: number };
  doctor: Awaited<ReturnType<typeof collectDoctorReport>>;
  vital: ReturnType<typeof buildVitalReport>;
  recommendedSurfaces: SurfaceRecommendation[];
  nextActions: NextAction[];
};

export type SetupReadinessInput = {
  surfaces: Pick<SetupReport['surfaces'], 'rows'>;
  surfaceHealth: SetupReport['surfaceHealth'];
  reasoning: SetupReport['reasoning'];
  doctor: Pick<SetupReport['doctor'], 'summaries'>;
  vital: Pick<SetupReport['vital'], 'checks'>;
};

/** Read-only HTTP evidence using the same probe as surfaces status. Never starts a surface. */
export async function collectSetupSurfaceHealth(
  definitions: SurfaceRuntimeDefinition[] = loadSurfaceManifest().surfaces
): Promise<Record<string, SetupSurfaceHealth>> {
  const entries = await Promise.all(
    definitions.map(async (definition): Promise<[string, SetupSurfaceHealth]> => {
      if (definition.enabled === false) {
        return [definition.id, { status: 'unknown', detail: 'disabled' }];
      }
      const health = await probeSurfaceHealth(definition);
      return [
        definition.id,
        {
          ...health,
          ...(definition.port ? { url: `http://127.0.0.1:${definition.port}` } : {}),
        },
      ];
    })
  );
  return Object.fromEntries(entries);
}

export async function runSetupReport(): Promise<SetupReport> {
  return runSetupReportWithPersona({});
}

export async function runSetupReportWithPersona(options: {
  persona?: SetupPersona;
  quiet?: boolean;
}): Promise<SetupReport> {
  const quiet = options.quiet || options.persona === 'first-time-user';
  const surfaces = await setupSurfaces({ quiet });
  const surfaceHealth = await collectSetupSurfaceHealth();
  const services = await setupServices({ quiet });
  const reasoning = await runReasoningSetup({ quiet });
  const doctor = await collectDoctorReport({});
  const vital = buildVitalReport();
  const readiness = { surfaces, surfaceHealth, reasoning, doctor, vital };
  const recommendedSurfaces = buildRecommendedSurfaces(readiness);
  const nextActions = buildFirstTimeUserNextActions(readiness);

  return {
    surfaces,
    surfaceHealth,
    services,
    reasoning,
    doctor,
    vital,
    recommendedSurfaces,
    nextActions,
  };
}

export function buildProfileSetupNextAction(
  vital: Pick<ReturnType<typeof buildVitalReport>, 'checks'>
): NextAction | undefined {
  const profileCheckIds = new Set([
    'sovereign_identity',
    'agent_identity',
    'sovereign_vision',
    'onboarding_summary',
  ]);
  const profileGaps = vital.checks.filter(
    (check) => profileCheckIds.has(check.id) && check.status !== 'ok'
  );
  if (profileGaps.length === 0) return undefined;
  return buildNextAction({
    title: 'Complete identity and onboarding profile',
    reason: `Vital reports ${profileGaps.length} missing or invalid profile files: ${profileGaps.map((check) => check.label).join(', ')}.`,
    next_action_type: 'bootstrap_environment',
    suggested_command: 'pnpm onboarding',
  });
}

type TaskReadiness = Pick<SurfaceRecommendation, 'readiness' | 'reason' | 'openUrl'> & {
  nextAction?: NextAction;
};

function inspectTaskSurfaces(report: SetupReadinessInput, ids: string[]): TaskReadiness {
  for (const id of ids) {
    const row = report.surfaces.rows.find((entry) => entry.surface === id);
    if (!row) {
      const reason = `Surface ${id} is not in the current registry.`;
      return {
        readiness: 'unavailable',
        reason,
        nextAction: buildNextAction({
          title: `Inspect missing surface ${id}`,
          reason,
          next_action_type: 'inspect_artifact',
          suggested_command: 'pnpm surfaces setup',
        }),
      };
    }
    if (row.enabled === 'disabled') {
      const reason = `Surface ${id} is disabled. Reconcile leaves it disabled; enable it only if you want this task.`;
      return {
        readiness: 'unavailable',
        reason,
        nextAction: buildNextAction({
          title: `Enable ${id} when needed`,
          reason,
          next_action_type: 'run_command',
          suggested_command: `pnpm surfaces enable --surface ${id}`,
        }),
      };
    }
    if (row.auth === 'missing') {
      const reason = `Surface ${id} needs authentication. ${row.hint}`;
      return {
        readiness: 'needs_setup',
        reason,
        nextAction: buildNextAction({
          title: `Set up authentication for ${id}`,
          reason,
          next_action_type: 'bootstrap_environment',
          suggested_command: 'pnpm surfaces setup',
        }),
      };
    }
    const health = report.surfaceHealth[id];
    if (!health || health.status === 'unknown') {
      const reason = `Surface ${id} is configured, but live readiness is unverified (${health?.detail || 'not_probed'}). Credentials or a running PID alone do not prove delivery.`;
      return {
        readiness: 'unverified',
        reason,
        nextAction: buildNextAction({
          title: `Verify ${id} before use`,
          reason,
          next_action_type: 'inspect_artifact',
          suggested_command: 'pnpm surfaces status',
        }),
      };
    }
    if (health.status !== 'healthy') {
      const accessDenied = health.detail === 'http_401' || health.detail === 'http_403';
      const reason = accessDenied
        ? `Surface ${id} rejected the health request (${health.detail}); verify the local viewer identity and scope before using it.`
        : `Surface ${id} is not healthy (${health.detail}). If it is still starting, check status again; otherwise use the targeted repair.`;
      return {
        readiness: 'needs_attention',
        reason,
        nextAction: buildNextAction({
          title: accessDenied ? `Check access to ${id}` : `Start or repair ${id}`,
          reason,
          next_action_type: accessDenied ? 'inspect_artifact' : 'repair_surface',
          suggested_command: accessDenied
            ? 'pnpm surfaces status'
            : `pnpm surfaces repair -- --surface ${id}`,
        }),
      };
    }
  }
  return {
    readiness: 'ready',
    reason: `Live health checks passed: ${ids.map((id) => `${id} (${report.surfaceHealth[id].detail})`).join(', ')}. Requests still check their own permissions and service requirements.`,
    openUrl: report.surfaceHealth[ids[0]]?.url,
  };
}

function firstRequestPrerequisite(report: SetupReadinessInput): NextAction | undefined {
  const profile = buildProfileSetupNextAction(report.vital);
  if (profile) return profile;
  if (report.reasoning.must > 0) {
    return buildNextAction({
      title: 'Configure reasoning for your first request',
      reason: `Reasoning has ${report.reasoning.must} required setup gaps. The UI can open, but real work needs a configured backend.`,
      next_action_type: 'bootstrap_environment',
      suggested_command: 'pnpm reasoning:setup',
    });
  }
  const baseline = report.doctor.summaries.find(
    (summary) => summary.manifestId === 'kyberion-runtime-baseline' && summary.counts.must > 0
  );
  if (baseline) {
    return buildNextAction({
      title: 'Complete the required local runtime setup',
      reason: `Doctor reports ${baseline.counts.must} required local runtime gaps.`,
      next_action_type: 'bootstrap_environment',
      suggested_command: 'pnpm env:bootstrap --manifest kyberion-runtime-baseline --apply',
    });
  }
  return undefined;
}

export function buildRecommendedSurfaces(report: SetupReadinessInput): SurfaceRecommendation[] {
  const tasks = [
    {
      id: 'concierge' as const,
      title: 'Concierge: request, decide, receive',
      whenToUse: 'Start here to ask for an outcome, review approvals, and find delivered results.',
      surfaces: ['concierge'],
      optional: false,
    },
    {
      id: 'chronos' as const,
      title: 'Chronos: inspect and recover',
      whenToUse: 'Use this to inspect running work and investigate a runtime problem.',
      surfaces: ['chronos-mirror-v2'],
      optional: false,
    },
    {
      id: 'voice-first-win' as const,
      title: 'Presence Studio: try voice',
      whenToUse: 'Use this for live transcripts and conversational voice feedback.',
      surfaces: ['presence-studio', 'voice-hub'],
      optional: true,
    },
    {
      id: 'messaging' as const,
      title: 'Slack: work in a thread',
      whenToUse: 'Enable this only when you want remote conversation and follow-up in Slack.',
      surfaces: ['slack-bridge'],
      optional: true,
    },
  ];

  return tasks.map((task): SurfaceRecommendation => {
    let readiness = inspectTaskSurfaces(report, task.surfaces);
    if (readiness.readiness === 'ready' && task.id === 'concierge') {
      const prerequisite = firstRequestPrerequisite(report);
      if (prerequisite) {
        readiness = {
          ...readiness,
          readiness: 'needs_setup',
          reason: prerequisite.reason,
          nextAction: prerequisite,
        };
      }
    }
    if (readiness.readiness === 'ready' && task.id === 'voice-first-win') {
      const voice = report.doctor.summaries.find(
        (summary) => summary.manifestId === 'meeting-participation-runtime'
      );
      if (!voice || voice.counts.must + voice.counts.should > 0) {
        const reason = voice
          ? `Voice prerequisites have ${voice.counts.must} required and ${voice.counts.should} recommended gaps.`
          : 'The surfaces respond, but voice prerequisites were not checked in this report.';
        readiness = {
          ...readiness,
          readiness: voice ? 'needs_setup' : 'unverified',
          reason,
          nextAction: buildNextAction({
            title: 'Check voice prerequisites',
            reason,
            next_action_type: 'inspect_artifact',
            suggested_command: 'pnpm kyberion doctor --runtime voice',
          }),
        };
      }
    }
    const nextAction =
      readiness.nextAction ||
      buildNextAction({
        title:
          task.id === 'concierge'
            ? 'Open Concierge and make your first request'
            : `Open ${task.title.split(':')[0]}`,
        reason: readiness.reason,
        next_action_type: 'inspect_artifact',
        ...(readiness.openUrl
          ? { suggested_followup_request: `Open ${readiness.openUrl}` }
          : { suggested_command: 'pnpm surfaces status' }),
      });
    return {
      ...task,
      ...readiness,
      nextAction,
      ...(nextAction.suggested_command ? { suggestedCommand: nextAction.suggested_command } : {}),
    };
  });
}

/** One next step for the default request path; optional integrations never block it. */
export function buildFirstTimeUserNextActions(report: SetupReadinessInput): NextAction[] {
  return [buildRecommendedSurfaces(report)[0].nextAction];
}

export function formatSetupReport(report: SetupReport, persona: SetupPersona): string {
  if (persona === 'first-time-user') {
    const primary = report.recommendedSurfaces[0];
    const lines = [
      '',
      `First request: ${primary.readiness}`,
      ...report.nextActions.flatMap(formatNextAction),
      '',
      'Choose by task:',
    ];
    for (const surface of report.recommendedSurfaces) {
      lines.push(
        `- ${surface.title} [${surface.readiness}]${surface.optional ? ' (optional)' : ''}`
      );
      lines.push(`  use when: ${surface.whenToUse}`);
      lines.push(`  evidence: ${surface.reason}`);
      if (surface.readiness === 'ready' && surface.openUrl)
        lines.push(`  open: ${surface.openUrl}`);
      else if (surface.suggestedCommand) lines.push(`  when needed: ${surface.suggestedCommand}`);
    }
    lines.push(
      '',
      'Optional service and messaging setup is informational; configure only what your request needs.',
      'For all service/auth details: pnpm service:setup. For runtime diagnostics: pnpm surfaces status.'
    );
    return lines.join('\n');
  }

  const lines = [
    '',
    formatSetupSummaryLine([
      [
        'identity/onboarding missing',
        report.vital.checks.filter(
          (check) =>
            [
              'sovereign_identity',
              'agent_identity',
              'sovereign_vision',
              'onboarding_summary',
            ].includes(check.id) && check.status !== 'ok'
        ).length,
      ],
      ['surface auth gaps', report.surfaces.summary.missing],
      ['service auth missing', report.services.summary.authMissing],
      ['service connections missing', report.services.summary.connectionMissing],
      ['reasoning must', report.reasoning.must],
      ['reasoning should', report.reasoning.should],
      ['doctor gaps', report.doctor.totalMissing],
    ]),
  ];
  if (report.doctor.summaries.length > 0) {
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
