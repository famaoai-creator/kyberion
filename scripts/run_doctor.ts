#!/usr/bin/env node
import {
  listEnvironmentManifestIds,
  listScheduledPipelines,
  loadEnvironmentManifest,
  getGovernanceControlSummary,
  probeManifest,
  pathResolver,
  readJanitorLastRunMs,
  safeExistsSync,
  safeReadFile,
  inspectMeshHub,
  isSurfaceOutboxDue,
  listSurfaceDeadLetters,
  listSurfaceDeadTargets,
  listSurfaceOutboxMessages,
} from '@agent/core';
import { buildNextAction, formatNextAction } from '@agent/core';
import { formatEnvValidationReport, validateEnv } from '@agent/core';
import {
  discoverProviders,
  evaluateDegradation,
  listDemotedProviders,
  loadHealthThresholds,
  metrics,
  type EnvValidationReport,
  type LatencyRegression,
} from '@agent/core';
import { getEmbeddingBackend, installEmbeddingBackendIfAvailable } from '@agent/core';
import { probeAppleIntelligence } from '@agent/core';
import { collectMissionHygieneReport, formatMissionHygieneLine } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { summarizeBackupStatus } from './backup.js';
import { formatDoctorSummary, summarizeManifestDoctor } from './environment-doctor.js';

const DEFAULT_MANIFESTS = ['kyberion-runtime-baseline', 'reasoning-backend'];
const MISSION_MANIFESTS = [
  'kyberion-runtime-baseline',
  'reasoning-backend',
  'meeting-participation-runtime',
];
const RUNTIME_PRESETS: Record<string, string[]> = {
  meeting: ['meeting-participation-runtime'],
  voice: ['meeting-participation-runtime'],
  browser: ['meeting-participation-runtime'],
  baseline: DEFAULT_MANIFESTS,
};
const JANITOR_SUBMIT_MARKER = 'runtime/state/janitor-last-submit.json';
const JANITOR_MAINTENANCE_TTL_MS = 24 * 60 * 60 * 1000;

export interface DoctorRunReport {
  totalMissing: number;
  rollupLines: string[];
  summaries: Array<{
    manifestId: string;
    lines: string[];
    counts: { must: number; should: number; nice: number };
  }>;
  scheduleLines: string[];
  maintenanceLines: string[];
  governanceLines: string[];
  backupLines: string[];
  meshDeliveryLines: string[];
  surfaceDeliveryLines: string[];
  localCapabilityLines: string[];
}

/**
 * OP-04 Task 4 — single 🟢/🟡/🔴 health rollup with at most three reasons.
 * Combines the degradation evaluation (Task 1, evaluation only — the hourly
 * watch owns alerting), manifest gaps, and env validation.
 */
export function collectHealthRollupLines(
  totalMissing: number,
  envReport: EnvValidationReport
): string[] {
  const reasons: string[] = [];
  let verdict: 'green' | 'yellow' | 'red' = 'green';
  const promote = (level: 'yellow' | 'red') => {
    if (level === 'red' || verdict === 'red') verdict = level === 'red' ? 'red' : verdict;
    else verdict = 'yellow';
  };

  try {
    const thresholds = loadHealthThresholds();
    const degradation = evaluateDegradation({
      regressions: metrics.detectRegressions(
        thresholds.regression_multiplier
      ) as LatencyRegression[],
      demotedProviders: listDemotedProviders(discoverProviders()),
      thresholds,
    });
    if (degradation.verdict !== 'green') {
      promote(degradation.verdict);
      reasons.push(degradation.findings[0]?.detail ?? 'degradation findings present');
    }
  } catch (err) {
    promote('yellow');
    reasons.push(`degradation evaluation failed: ${err}`);
  }

  if (envReport.errors.length > 0) {
    promote('red');
    reasons.push(`${envReport.errors.length} required env variable(s) missing`);
  }
  if (totalMissing > 0) {
    promote('yellow');
    reasons.push(`${totalMissing} required capability(ies) missing`);
  }

  const icon = verdict === 'green' ? '🟢' : verdict === 'yellow' ? '🟡' : '🔴';
  if (reasons.length === 0) {
    return [`System health: ${icon} green — no degradation, env, or capability findings`];
  }
  return [
    `System health: ${icon} ${verdict}`,
    ...reasons.slice(0, 3).map((reason) => `  - ${reason}`),
  ];
}

/**
 * KM-02 Task 2 — make the hash-embedding fallback visible: on non-Apple
 * hosts "semantic" search is a hash-bucket approximation, and operators
 * should not mistake it for real embeddings.
 */
export function collectSemanticSearchDoctorLine(): string {
  try {
    installEmbeddingBackendIfAvailable();
    const backend = getEmbeddingBackend();
    if (!backend) return 'Semantic search: disabled (KYBERION_DISABLE_EMBEDDINGS)';
    if (backend.name === 'local-hash-embedding') {
      return 'Semantic search: ⚠ DEGRADED — hash-bucket approximation (local-hash-embedding), not real embeddings';
    }
    return `Semantic search: ${backend.name}`;
  } catch (err) {
    return `Semantic search: status unavailable (${err})`;
  }
}

export function collectPipelineScheduleDoctorLines(): string[] {
  const schedules = listScheduledPipelines().sort((a, b) => a.id.localeCompare(b.id));
  const lines = [`Pipeline schedules: ${schedules.length} registered`];
  if (schedules.length === 0) {
    lines.push(
      '  - none registered; start `node dist/scripts/chronos_daemon.js` to sync scheduled pipeline ADFs'
    );
    return lines;
  }
  for (const schedule of schedules.slice(0, 8)) {
    const trigger =
      schedule.trigger.type === 'cron'
        ? `${schedule.trigger.cron}${schedule.trigger.timezone ? ` ${schedule.trigger.timezone}` : ''}`
        : `${schedule.trigger.intervalMs ?? 0}ms`;
    lines.push(
      `  - ${schedule.id}: ${schedule.enabled ? 'enabled' : 'disabled'}; ${trigger}; last=${schedule.lastRun ?? 'never'}; status=${schedule.lastStatus ?? 'unknown'}`
    );
  }
  if (schedules.length > 8) lines.push(`  - ... ${schedules.length - 8} more`);
  return lines;
}

export async function collectMeshDeliveryDoctorLines(): Promise<string[]> {
  try {
    const report = await inspectMeshHub();
    if (report.delivery_count === 0 && report.dead_letter_count === 0) {
      return ['Mesh delivery: idle; no deliveries recorded'];
    }
    const stuck = report.routes.filter(
      (route) => route.state === 'queued' || route.state === 'dispatched'
    );
    const oldest = stuck
      .slice()
      .sort((left, right) => String(left.expires_at).localeCompare(String(right.expires_at)))[0];
    const lines = [
      `Mesh delivery: total=${report.delivery_count}; in_flight=${stuck.length}; dead_letter=${report.dead_letter_count}`,
    ];
    if (oldest) {
      lines.push(
        `  - oldest in-flight: ${oldest.delivery_id} (${oldest.state}, retries=${oldest.retry_count}, expires=${oldest.expires_at})`
      );
    }
    if (report.dead_letter_count > 0) {
      lines.push('  - inspect dead letters via `pnpm mesh:deliver --json` and mesh-hub-inspection');
    }
    return lines;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [`Mesh delivery: inspection unavailable (${message})`];
  }
}

const DOCTOR_SURFACES = ['slack', 'telegram', 'imessage', 'discord', 'chronos'];

export function collectSurfaceDeliveryDoctorLines(): string[] {
  const summaries = DOCTOR_SURFACES.map((surface) => {
    const messages = listSurfaceOutboxMessages(surface);
    const due = messages.filter((message) => isSurfaceOutboxDue(message)).length;
    const deferred = messages.length - due;
    const deadLetters = listSurfaceDeadLetters(surface).length;
    const deadTargets = listSurfaceDeadTargets(surface).length;
    return { surface, pending: messages.length, due, deferred, deadLetters, deadTargets };
  });
  const pending = summaries.reduce((sum, item) => sum + item.pending, 0);
  const deadLetters = summaries.reduce((sum, item) => sum + item.deadLetters, 0);
  const deadTargets = summaries.reduce((sum, item) => sum + item.deadTargets, 0);
  const lines = [
    `Surface delivery: pending=${pending}; dead_letter=${deadLetters}; dead_target=${deadTargets}`,
  ];
  for (const item of summaries.filter(
    (summary) => summary.pending || summary.deadLetters || summary.deadTargets
  )) {
    lines.push(
      `  - ${item.surface}: pending=${item.pending} due=${item.due} deferred=${item.deferred} dead_letter=${item.deadLetters} dead_target=${item.deadTargets}`
    );
  }
  if (deadLetters > 0 || deadTargets > 0) {
    lines.push(
      '  - inspect surface dead-letter/dead-target records under active/shared/coordination/channels'
    );
  }
  return lines;
}

export function collectBackupDoctorLines(): string[] {
  const status = summarizeBackupStatus();
  if (status.status === 'missing') {
    return [
      'Backup status: missing; run `KYBERION_BACKUP_PASSPHRASE=... pnpm backup create --scope all --encrypt`',
    ];
  }
  const age = status.latestAgeHours?.toFixed(1) ?? 'unknown';
  return [
    `Backup status: ${status.status}; latest=${status.latestName}; age=${age}h; archives=${status.count}; dir=${status.backupDir}`,
  ];
}

export function collectMaintenanceDoctorLines(): string[] {
  const lastRunMs = readJanitorLastRunMs();
  const submitPath = pathResolver.shared(JANITOR_SUBMIT_MARKER);
  const submitPending = safeExistsSync(submitPath);
  let lastSubmittedAt: number | null = null;
  if (submitPending) {
    try {
      const raw = safeReadFile(submitPath, { encoding: 'utf8' }) as string;
      const parsed = JSON.parse(raw) as { submitted_at?: string };
      const submittedAt = Date.parse(String(parsed?.submitted_at || ''));
      lastSubmittedAt = Number.isFinite(submittedAt) ? submittedAt : null;
    } catch {
      lastSubmittedAt = null;
    }
  }

  if (lastRunMs === null && !submitPending) {
    return ['Maintenance: janitor idle; no last run marker'];
  }

  const ageHours =
    lastRunMs !== null ? ((Date.now() - lastRunMs) / (60 * 60 * 1000)).toFixed(1) : 'unknown';
  const pendingState =
    submitPending &&
    lastSubmittedAt !== null &&
    Date.now() - lastSubmittedAt < JANITOR_MAINTENANCE_TTL_MS
      ? 'pending'
      : submitPending
        ? 'submitted'
        : 'idle';

  return [
    `Maintenance: janitor ${pendingState}; last_run=${lastRunMs === null ? 'never' : `${ageHours}h ago`}; submit_marker=${submitPending ? 'present' : 'absent'}`,
  ];
}

function isReasoningBackendSummary(summary: DoctorRunReport['summaries'][number]): boolean {
  return (
    summary.manifestId === 'reasoning-backend' ||
    summary.lines.some((line) => line.includes('reasoning-backend.any-real'))
  );
}

function runtimeToDependencyActuator(runtime?: string): string | null {
  switch (runtime) {
    case 'meeting':
    case 'browser':
      return 'browser';
    case 'voice':
      return 'voice';
    default:
      return null;
  }
}

function formatMissingCapabilityNextStep(
  firstMissingSummary: DoctorRunReport['summaries'][number]
): { message: string; title: string; reason: string; command: string } {
  if (isReasoningBackendSummary(firstMissingSummary)) {
    return {
      message:
        'Next step: run `pnpm reasoning:setup`. Configure one real backend: Codex/Gemini/AGY CLI auth, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` (or `KYBERION_OPENROUTER_KEY`), `KYBERION_NEMOTRON_URL`, or `KYBERION_LOCAL_LLM_URL`. Use `KYBERION_REASONING_BACKEND=stub` only for explicit offline test mode.',
      title: 'Configure reasoning backend',
      reason: `Doctor reports ${firstMissingSummary.counts.must} must and ${firstMissingSummary.counts.should} should reasoning backend gaps.`,
      command: 'pnpm reasoning:setup',
    };
  }
  return {
    message: `Next step: run \`pnpm env:bootstrap --manifest ${firstMissingSummary.manifestId} --apply\` for missing must/should items.`,
    title: `Bootstrap ${firstMissingSummary.manifestId}`,
    reason: `Doctor reports ${firstMissingSummary.counts.must} must and ${firstMissingSummary.counts.should} should gaps.`,
    command: `pnpm env:bootstrap --manifest ${firstMissingSummary.manifestId} --apply`,
  };
}

export async function collectDoctorReport(argv: {
  manifest?: string;
  runtime?: string;
  all?: boolean;
  mission?: string;
}): Promise<DoctorRunReport> {
  const missionId = argv.mission ? String(argv.mission) : process.env.MISSION_ID || undefined;
  if (missionId) process.env.MISSION_ID = missionId;

  const manifestIds = argv.all
    ? listEnvironmentManifestIds()
    : argv.manifest
      ? [String(argv.manifest)]
      : argv.runtime
        ? (RUNTIME_PRESETS[String(argv.runtime)] ?? [String(argv.runtime)])
        : missionId
          ? MISSION_MANIFESTS
          : DEFAULT_MANIFESTS;

  const summaries: DoctorRunReport['summaries'] = [];
  let totalMissing = 0;

  for (const manifestId of manifestIds) {
    const manifest = loadEnvironmentManifest(manifestId);
    const probes = await probeManifest(manifest, {
      ...(missionId ? { mission_id: missionId } : {}),
    });
    const summary = summarizeManifestDoctor(manifest, probes);
    const lines = formatDoctorSummary(summary);
    summaries.push({ manifestId, lines, counts: summary.counts });
    totalMissing += summary.counts.must + summary.counts.should;
  }

  const governance = getGovernanceControlSummary();
  const envReport = validateEnv();
  const governanceLines = [
    `Governance controls: kill_switch=${governance.kill_switch_monitoring ? 'armed' : 'idle'}; policies=${governance.policy_engine_loaded}/${governance.policy_engine_declared}${governance.policy_engine_declared > governance.policy_engine_loaded ? ' (DROPPED — check agent-policies.yaml)' : ''}; pending_approvals=${governance.pending_approvals}; approval_rules=${governance.approval_rules}; shell_rules=${governance.shell_allow_rules}/${governance.shell_deny_rules}; egress_mode=${governance.egress_mode}; egress_domains=${governance.egress_allowlist_domains}; anomalies=${governance.anomaly_agents.length}`,
    ...formatEnvValidationReport(envReport),
    collectSemanticSearchDoctorLine(),
  ];

  return {
    totalMissing,
    rollupLines: collectHealthRollupLines(totalMissing, envReport),
    summaries,
    scheduleLines: collectPipelineScheduleDoctorLines(),
    maintenanceLines: collectMaintenanceDoctorLines(),
    governanceLines,
    backupLines: collectBackupDoctorLines(),
    meshDeliveryLines: await collectMeshDeliveryDoctorLines(),
    surfaceDeliveryLines: collectSurfaceDeliveryDoctorLines(),
    localCapabilityLines: await collectLocalCapabilityDoctorLines(),
  };
}

/**
 * On-device capability visibility: what runs locally on THIS machine with
 * zero configuration (Apple Intelligence lanes). Purely informational —
 * absence is normal on non-Apple hosts and never counts as missing.
 */
async function collectLocalCapabilityDoctorLines(): Promise<string[]> {
  try {
    const availability = await probeAppleIntelligence();
    if (!availability.available) {
      return [
        `Apple Intelligence: unavailable (${availability.reason || 'unknown'}) — cloud/configured backends handle all lanes`,
        formatMissionHygieneLine(collectMissionHygieneReport()),
      ];
    }
    return [
      'Apple Intelligence: AVAILABLE — local lanes: text assist (classify/summarize), vision OCR, speech-to-text (zero-config bridge). Demo: pnpm check:apple-fm',
      formatMissionHygieneLine(collectMissionHygieneReport()),
    ];
  } catch (err) {
    return [
      `Apple Intelligence: probe failed (${err instanceof Error ? err.message : String(err)})`,
    ];
  }
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('manifest', { type: 'string' })
    .option('runtime', {
      type: 'string',
      describe: 'Runtime preset to inspect: meeting, voice, browser, or baseline',
    })
    .option('all', { type: 'boolean', default: false })
    .option('mission', { type: 'string' })
    .parseSync();

  const report = await collectDoctorReport(argv);

  for (const line of report.rollupLines) {
    console.log(line);
  }
  console.log('');
  for (const summary of report.summaries) {
    for (const line of summary.lines) {
      console.log(line);
    }
    console.log('');
  }
  for (const line of report.scheduleLines) {
    console.log(line);
  }
  for (const line of report.maintenanceLines) {
    console.log(line);
  }
  for (const line of report.governanceLines) {
    console.log(line);
  }
  for (const line of report.backupLines) {
    console.log(line);
  }
  for (const line of report.localCapabilityLines) {
    console.log(line);
  }
  for (const line of report.meshDeliveryLines) {
    console.log(line);
  }
  for (const line of report.surfaceDeliveryLines) {
    console.log(line);
  }
  console.log('');

  if (report.totalMissing === 0) {
    console.log('All required capabilities are satisfied.');
    if (!argv.manifest && !argv.runtime && !argv.all) {
      console.log(
        'Want the right surface next? Run `pnpm setup:report --persona first-time-user` for a recommended surface guide.'
      );
    }
    process.exit(0);
  }

  const missionId = argv.mission ? String(argv.mission) : process.env.MISSION_ID || undefined;
  if (!missionId && !argv.manifest && !argv.runtime && !argv.all) {
    console.log(
      'Tip: pass `--runtime meeting --mission <id>` to include browser, voice, audio, and mission-scoped consent checks.'
    );
  }
  const onDemandActuator = runtimeToDependencyActuator(
    argv.runtime ? String(argv.runtime) : undefined
  );
  const needsMeetingHint =
    argv.mission ||
    (argv.runtime && ['meeting', 'voice', 'browser'].includes(String(argv.runtime)));
  const firstMissingSummary = report.summaries.find(
    (summary) => summary.counts.must + summary.counts.should > 0
  );
  if (firstMissingSummary) {
    const nextStep = formatMissingCapabilityNextStep(firstMissingSummary);
    console.log(
      needsMeetingHint && !isReasoningBackendSummary(firstMissingSummary)
        ? `${nextStep.message} For meeting runtime gaps, use \`pnpm env:bootstrap --manifest meeting-participation-runtime --apply\`.`
        : nextStep.message
    );
    console.log(
      'Need to decide which surface to use after bootstrap? Run `pnpm setup:report --persona first-time-user`.'
    );
    if (onDemandActuator) {
      console.log(
        `For actuator-level pulls, run \`pnpm deps:check --actuator ${onDemandActuator}\` before starting that surface.`
      );
    }
    const nextAction = buildNextAction({
      title: nextStep.title,
      reason: nextStep.reason,
      next_action_type: isReasoningBackendSummary(firstMissingSummary)
        ? 'run_command'
        : 'bootstrap_environment',
      suggested_command: nextStep.command,
    });
    for (const line of formatNextAction(nextAction)) {
      console.log(line);
    }
  } else {
    console.log('Next step: inspect doctor findings above and rerun the relevant setup command.');
    console.log(
      'Need to decide which surface to use after bootstrap? Run `pnpm setup:report --persona first-time-user`.'
    );
    if (onDemandActuator) {
      console.log(
        `For actuator-level pulls, run \`pnpm deps:check --actuator ${onDemandActuator}\` before starting that surface.`
      );
    }
  }
  process.exit(1);
}

const isDirect = process.argv[1] && /run_doctor\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}

export { main as runDoctor };
