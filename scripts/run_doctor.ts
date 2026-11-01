#!/usr/bin/env node
import '@agent/core/environment-capability-probes';
import {
  listEnvironmentManifestIds,
  loadEnvironmentManifest,
  probeManifest,
} from '@agent/core/environment-capability';
import { installBaselineBuildReadinessInspector } from './baseline_build_readiness.js';
import { readJanitorLastRunMs, readJanitorLastSubmissionMs } from '@agent/core/storage-janitor';
import { inspectMeshHub } from '@agent/core/mesh/mesh-hub-inspection';
import { getGovernanceControlSummary } from '@agent/core/governance/governance-status';
import {
  BACKUP_ARCHIVE_MAX_AGE_HOURS,
  BACKUP_PASSPHRASE_INTRODUCE_COMMAND,
  evaluateOpsHealth,
  type BackupPassphraseObservation,
  formatOpsHealthFinding,
  type OpsHealthReport,
} from '@agent/core/ops-health';
import { readBackupDrillReceipt, readJanitorFailureMarker } from '@agent/core/ops-health-state';
import { collectOpsHealthInput, probeBackupPassphraseCached } from './lib/ops-health-input.js';
import {
  listSurfaceDeadLetters,
  listSurfaceDeadTargets,
  listSurfaceOutboxMessages,
} from '@agent/core/surface/surface-coordination-store';
import { isSurfaceOutboxDue } from '@agent/core/surface/surface-delivery';
import type { SurfaceAsyncChannel } from '@agent/core/surface/channel-surface-types';
import { listDesktopObservationSources } from '@agent/core/virtual/desktop-recording';
import { probeDesktopObservationReadiness } from '@agent/core/virtual/desktop-observation-readiness';
import { buildNextAction, formatNextAction } from '@agent/core/next-action';
import { formatEnvValidationReport, validateEnv } from '@agent/core/env-validator';
import { evaluateDegradation, loadHealthThresholds } from '@agent/core/health-degradation';
import { discoverProviders } from '@agent/core/provider/provider-discovery';
import { listDemotedProviders } from '@agent/core/provider/provider-health-view';
import { metrics, metricsWithheldNotice } from '@agent/core/metrics';
import type { EnvValidationReport } from '@agent/core/env-validator';
import type { LatencyRegression } from '@agent/core/health-degradation';
import { getEmbeddingBackend } from '@agent/core/embedding-backend';
import { installEmbeddingBackendIfAvailable } from '@agent/core/embedding-bootstrap';
import {
  probeAppleIntelligence,
  probeAppleIntelligenceCapabilities,
  probeAppleSpeechAvailability,
} from '@agent/core/apple-intelligence-bridge';
import {
  collectMissionHygieneReport,
  formatMissionHygieneLine,
} from '@agent/core/mission/mission-hygiene';
import { createStandardYargs } from '@agent/core/cli-utils';
import { t } from '@agent/core/t';
import { summarizeBackupStatus } from './backup.js';
import { formatDoctorSummary, summarizeManifestDoctor } from './environment-doctor.js';
import {
  defineScript,
  isDirectScript,
  ScriptExitError,
  stripSharedScriptFlags,
  type ScriptContext,
} from './lib/harness.js';
import { formatCliUsage, hasHelpFlag, type CliGuardSpec } from './lib/cli-guard.js';
import { getRegisteredEnvText, isVitestProcess, setRegisteredEnv } from '@agent/core/foundation';
import {
  formatAppPreflightReport,
  runAppPreflight,
  type AppPreflightReport,
} from './app_preflight.js';

// The repo-build probe must judge on the same input-set/emit basis as
// `pnpm run check` — install the canonical compiler-outputs inspector.
installBaselineBuildReadinessInspector();

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
  desktopObservationLines: string[];
  appPreflight?: AppPreflightReport;
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

  let partialNotice: string | undefined;
  try {
    const thresholds = loadHealthThresholds();
    let withheld = 0;
    const regressions = metrics.detectRegressions(
      thresholds.regression_multiplier,
      { all: true },
      {
        onWithheld: (partitions) => {
          withheld = partitions;
        },
      }
    ) as LatencyRegression[];
    partialNotice = metricsWithheldNotice('doctor latency regressions', withheld);
    const degradation = evaluateDegradation({
      regressions,
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
  const partial = partialNotice ? [`  - PARTIAL: ${partialNotice}`] : [];
  if (reasons.length === 0) {
    return [
      `System health: ${icon} green — no degradation, env, or capability findings`,
      ...partial,
    ];
  }
  return [
    `System health: ${icon} ${verdict}`,
    ...reasons.slice(0, 3).map((reason) => `  - ${reason}`),
    ...partial,
  ];
}

/**
 * Report embedding backend quality through capability metadata so new
 * approximate backends need no provider-specific doctor branch.
 */
export function collectSemanticSearchDoctorLine(): string {
  try {
    installEmbeddingBackendIfAvailable();
    const backend = getEmbeddingBackend();
    if (!backend) return 'Semantic search: disabled (KYBERION_DISABLE_EMBEDDINGS)';
    if (backend.quality === 'approximate') {
      return (
        'Semantic search: ⚠ DEGRADED — ' +
        (backend.qualityNote || 'approximate embeddings') +
        ' (' +
        backend.name +
        ')'
      );
    }
    return backend.qualityNote
      ? 'Semantic search: ' + backend.name + ' — ' + backend.qualityNote
      : 'Semantic search: ' + backend.name;
  } catch (err) {
    return 'Semantic search: status unavailable (' + err + ')';
  }
}
/**
 * Pure: one verdict line per resident-ops finding (ops-health.ts) — the same
 * findings the baseline maps onto L10/L12, so doctor and baseline agree.
 */
export function collectOpsHealthDoctorLines(
  report: OpsHealthReport,
  registeredScheduleCount: number | null
): string[] {
  const scheduleNote =
    registeredScheduleCount === null
      ? 'schedule registry unreadable'
      : `${registeredScheduleCount} schedule(s) registered`;
  if (report.findings.length === 0) {
    return [`Resident ops: healthy; ${scheduleNote}`];
  }
  const errors = report.findings.filter((finding) => finding.severity === 'error').length;
  const lines = [
    `Resident ops: ${report.findings.length} finding(s) (${errors} error, ${report.findings.length - errors} warn); ${scheduleNote}`,
  ];
  for (const finding of report.findings) {
    lines.push(`  - ${formatOpsHealthFinding(finding)}`);
  }
  return lines;
}

export async function collectPipelineScheduleDoctorLines(): Promise<string[]> {
  try {
    const now = new Date();
    // OS unit inspection shells out to the host service manager — never under test.
    const input = await collectOpsHealthInput({ now, inspectUnits: !isVitestProcess() });
    return collectOpsHealthDoctorLines(
      evaluateOpsHealth(input, now),
      input.schedules ? input.schedules.length : null
    );
  } catch (err) {
    return [
      `Resident ops: evaluation unavailable (${err instanceof Error ? err.message : String(err)}); rerun \`pnpm pipeline --input pipelines/baseline-check.json\``,
    ];
  }
}

export async function collectMeshDeliveryDoctorLines(): Promise<string[]> {
  try {
    const tenantId = String(
      getRegisteredEnvText('KYBERION_TENANT') || getRegisteredEnvText('KYBERION_TENANT_ID') || ''
    ).trim();
    const aliasNotice =
      !getRegisteredEnvText('KYBERION_TENANT') && getRegisteredEnvText('KYBERION_TENANT_ID')
        ? ' (deprecated KYBERION_TENANT_ID alias; prefer KYBERION_TENANT)'
        : '';
    // Mesh state is tenant-scoped; without a tenant there is nothing to inspect,
    // which is the normal single-operator state rather than a failure.
    if (!tenantId) {
      return ['Mesh delivery: not inspected; no tenant scope (set KYBERION_TENANT to inspect)'];
    }
    const report = await inspectMeshHub({
      tenantId,
    });
    if (report.delivery_count === 0 && report.dead_letter_count === 0) {
      return [`Mesh delivery: idle; no deliveries recorded${aliasNotice}`];
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
      lines.push(
        '  - inspect dead letters via `pnpm kyberion mesh deliver --json` and mesh-hub-inspection'
      );
    }
    return lines;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [`Mesh delivery: inspection unavailable (${message})`];
  }
}

const DOCTOR_SURFACES: SurfaceAsyncChannel[] = [
  'slack',
  'telegram',
  'imessage',
  'discord',
  'chronos',
];

export function collectSurfaceDeliveryDoctorLines(): string[] {
  const summaries = DOCTOR_SURFACES.map((surface) => {
    const messages = listSurfaceOutboxMessages(surface, { includeTenantNamespaces: true });
    const due = messages.filter((message) => isSurfaceOutboxDue(message)).length;
    const deferred = messages.length - due;
    const deadLetters = listSurfaceDeadLetters(surface, { includeTenantNamespaces: true }).length;
    const deadTargets = listSurfaceDeadTargets(surface, { includeTenantNamespaces: true }).length;
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

export function formatBackupDrillLine(receipt: ReturnType<typeof readBackupDrillReceipt>): string {
  if (!receipt) return 'restore drill: never run';
  if (receipt.ok) return `restore drill: ok at ${receipt.completed_at}`;
  if (receipt.reason === 'no_archive')
    return `restore drill: skipped at ${receipt.completed_at} (no archive — backup-daily must succeed first)`;
  return `restore drill: FAILED at ${receipt.completed_at}${receipt.error ? ` (${receipt.error.slice(0, 160)})` : ''}`;
}

/** Pure: where the backup passphrase comes from (never the value). */
export function formatBackupPassphraseNote(passphrase: BackupPassphraseObservation | null): string {
  if (!passphrase) return 'passphrase=not probed';
  if (passphrase.available) {
    return `passphrase=${passphrase.source}${passphrase.backend ? `(${passphrase.backend})` : ''}`;
  }
  return `passphrase=UNAVAILABLE (run \`${BACKUP_PASSPHRASE_INTRODUCE_COMMAND}\`)`;
}

export function collectBackupDoctorLines(): string[] {
  // Same freshness threshold as the ops-health backup finding.
  const status = summarizeBackupStatus(undefined, {
    staleAfterHours: BACKUP_ARCHIVE_MAX_AGE_HOURS,
  });
  // One keychain read at most (cached once reachable); never under test.
  const passphraseNote = formatBackupPassphraseNote(
    isVitestProcess() ? null : probeBackupPassphraseCached()
  );
  const drill = `${formatBackupDrillLine(readBackupDrillReceipt())}; ${passphraseNote}`;
  if (status.status === 'missing') {
    return [
      `Backup status: missing; ${drill}; run \`KYBERION_BACKUP_PASSPHRASE=... pnpm backup create --scope all --encrypt\``,
    ];
  }
  const age = status.latestAgeHours?.toFixed(1) ?? 'unknown';
  return [
    `Backup status: ${status.status}; latest=${status.latestName}; age=${age}h (limit ${BACKUP_ARCHIVE_MAX_AGE_HOURS}h); archives=${status.count}; ${drill}; dir=${status.backupDir}`,
  ];
}

export function collectMaintenanceDoctorLines(): string[] {
  const lastRunMs = readJanitorLastRunMs();
  const lastSubmittedAt = readJanitorLastSubmissionMs();
  const submitPending = lastSubmittedAt !== null;

  if (lastRunMs === null && !submitPending) {
    return ['Maintenance: janitor idle; no last run marker'];
  }

  const ageHours =
    lastRunMs !== null ? ((Date.now() - lastRunMs) / (60 * 60 * 1000)).toFixed(1) : 'unknown';
  const now = Date.now();
  // The submit marker is never cleared, so a run that completed after the last
  // submission settles it — otherwise doctor reports `pending` right after a run.
  const settled = lastRunMs !== null && lastSubmittedAt !== null && lastRunMs >= lastSubmittedAt;
  let pendingState: 'fresh' | 'pending' | 'submitted' | 'idle';
  if (
    lastRunMs !== null &&
    now - lastRunMs < JANITOR_MAINTENANCE_TTL_MS &&
    (settled || !submitPending)
  ) {
    pendingState = 'fresh';
  } else if (
    lastSubmittedAt !== null &&
    !settled &&
    now - lastSubmittedAt < JANITOR_MAINTENANCE_TTL_MS
  ) {
    pendingState = 'pending';
  } else if (submitPending && !settled) {
    pendingState = 'submitted';
  } else {
    pendingState = 'idle';
  }

  const failure = readJanitorFailureMarker();
  const failedAtMs = failure ? Date.parse(failure.failed_at) : NaN;
  const failureNote =
    failure && Number.isFinite(failedAtMs) && (lastRunMs === null || failedAtMs > lastRunMs)
      ? `; last_failure=${failure.failed_at} exit=${failure.exit_code ?? 'unknown'}${failure.log_path ? ` log=${failure.log_path}` : ''}`
      : '';
  return [
    `Maintenance: janitor ${pendingState}; last_run=${lastRunMs === null ? 'never' : `${ageHours}h ago`}; submit_marker=${submitPending ? 'present' : 'absent'}${failureNote}`,
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

export async function collectDesktopObservationDoctorLines(): Promise<string[]> {
  const readiness = await probeDesktopObservationReadiness();
  const available = readiness.filter((entry) => entry.available).map((entry) => entry.source_id);
  const unavailable = readiness
    .filter((entry) => !entry.available)
    .map((entry) => `${entry.source_id}=${entry.reason}`);
  return [
    t('recorder:recorder_doctor_bridge', {
      bridge: available.some((source) => source !== 'clipboard') ? 'available' : 'unavailable',
      registry: listDesktopObservationSources().length,
      available: available.join(',') || 'none',
    }),
    ...(unavailable.length > 0
      ? [t('recorder:recorder_doctor_unavailable', { sources: unavailable.join('; ') })]
      : [t('recorder:recorder_doctor_all_available')]),
    t('recorder:recorder_doctor_tier'),
  ];
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
  platform?: 'ios' | 'android' | 'all';
  full?: boolean;
}): Promise<DoctorRunReport> {
  const missionId = argv.mission
    ? String(argv.mission)
    : getRegisteredEnvText('MISSION_ID') || undefined;
  if (missionId) setRegisteredEnv('MISSION_ID', missionId);

  const appPreflight =
    argv.runtime === 'app'
      ? runAppPreflight({
          platform: argv.platform,
          full: argv.full,
        })
      : undefined;
  const manifestIds =
    argv.runtime === 'app'
      ? []
      : argv.all
        ? listEnvironmentManifestIds()
        : argv.manifest
          ? [String(argv.manifest)]
          : argv.runtime
            ? (RUNTIME_PRESETS[String(argv.runtime)] ?? [String(argv.runtime)])
            : missionId
              ? MISSION_MANIFESTS
              : DEFAULT_MANIFESTS;

  const summaries: DoctorRunReport['summaries'] = [];
  let totalMissing = appPreflight
    ? appPreflight.items.filter((entry) => entry.status === 'fail').length
    : 0;

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
    scheduleLines: await collectPipelineScheduleDoctorLines(),
    maintenanceLines: collectMaintenanceDoctorLines(),
    governanceLines,
    backupLines: collectBackupDoctorLines(),
    meshDeliveryLines: await collectMeshDeliveryDoctorLines(),
    surfaceDeliveryLines: collectSurfaceDeliveryDoctorLines(),
    localCapabilityLines: await collectLocalCapabilityDoctorLines(),
    desktopObservationLines: await collectDesktopObservationDoctorLines(),
    ...(appPreflight ? { appPreflight } : {}),
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
    const capabilities = await probeAppleIntelligenceCapabilities();
    const speech = await probeAppleSpeechAvailability();
    const capabilityLines = [
      `Apple Speech readiness: ${JSON.stringify(speech)}`,
      `Apple Intelligence capability matrix: ${JSON.stringify(capabilities)}`,
      'Apple Intelligence PCC: not probed automatically (cloud access requires opt-in).',
    ];
    if (!availability.available) {
      return [
        `Apple Intelligence text assist: unavailable (${availability.reason || 'unknown'}) — configured backends remain available`,
        ...capabilityLines,
        formatMissionHygieneLine(collectMissionHygieneReport()),
      ];
    }
    return [
      'Apple Intelligence text assist: AVAILABLE (classify/summarize). Demo: pnpm check:apple-fm',
      ...capabilityLines,
      formatMissionHygieneLine(collectMissionHygieneReport()),
    ];
  } catch (err) {
    return [
      `Apple Intelligence: probe failed (${err instanceof Error ? err.message : String(err)})`,
    ];
  }
}

type DoctorArguments = {
  manifest?: string;
  runtime?: string;
  all?: boolean;
  mission?: string;
  platform?: 'ios' | 'android' | 'all';
  full?: boolean;
};

function normalizeDoctorArguments(args: string[]): string[] {
  return stripSharedScriptFlags(args);
}

async function parseDoctorArguments(args: string[]): Promise<DoctorArguments> {
  const parsed = await createStandardYargs([
    'node',
    'run_doctor',
    ...normalizeDoctorArguments(args),
  ])
    .option('manifest', { type: 'string' })
    .option('runtime', {
      type: 'string',
      describe: 'Runtime preset to inspect: app, meeting, voice, browser, or baseline',
    })
    .option('all', { type: 'boolean', default: false })
    .option('mission', { type: 'string' })
    .option('platform', { type: 'string', choices: ['ios', 'android', 'all'], default: 'all' })
    .option('full', { type: 'boolean', default: false })
    .parseSync();
  return {
    ...parsed,
    platform: parsed.platform as DoctorArguments['platform'],
  };
}

export function formatDoctorReport(report: DoctorRunReport, argv: DoctorArguments): string {
  const lines: string[] = [];
  for (const line of report.rollupLines) {
    lines.push(line);
  }
  lines.push('');
  for (const summary of report.summaries) {
    for (const line of summary.lines) {
      lines.push(line);
    }
    lines.push('');
  }
  for (const line of report.scheduleLines) {
    lines.push(line);
  }
  for (const line of report.maintenanceLines) {
    lines.push(line);
  }
  for (const line of report.governanceLines) {
    lines.push(line);
  }
  for (const line of report.backupLines) {
    lines.push(line);
  }
  for (const line of report.localCapabilityLines) {
    lines.push(line);
  }
  for (const line of report.meshDeliveryLines) {
    lines.push(line);
  }
  for (const line of report.surfaceDeliveryLines) {
    lines.push(line);
  }
  for (const line of report.desktopObservationLines) {
    lines.push(line);
  }
  if (report.appPreflight) {
    lines.push(...formatAppPreflightReport(report.appPreflight).split('\n'));
  }
  lines.push('');

  if (report.appPreflight) {
    if (report.totalMissing === 0) {
      lines.push('App runtime preflight is satisfied.');
    } else {
      lines.push(
        'Next step: resolve the app preflight items above, then rerun `pnpm kyberion doctor -- --runtime app`.'
      );
    }
    return lines.join('\n');
  }

  if (report.totalMissing === 0) {
    lines.push('All required capabilities are satisfied.');
    if (!argv.manifest && !argv.runtime && !argv.all) {
      lines.push(
        'Want the right surface next? Run `pnpm kyberion setup report --persona first-time-user` for a recommended surface guide.'
      );
    }
    return lines.join('\n');
  }

  const missionId = argv.mission
    ? String(argv.mission)
    : getRegisteredEnvText('MISSION_ID') || undefined;
  if (!missionId && !argv.manifest && !argv.runtime && !argv.all) {
    lines.push(
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
    lines.push(
      needsMeetingHint && !isReasoningBackendSummary(firstMissingSummary)
        ? `${nextStep.message} For meeting runtime gaps, use \`pnpm env:bootstrap --manifest meeting-participation-runtime --apply\`.`
        : nextStep.message
    );
    lines.push(
      'Need to decide which surface to use after bootstrap? Run `pnpm kyberion setup report --persona first-time-user`.'
    );
    if (onDemandActuator) {
      lines.push(
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
      lines.push(line);
    }
  } else {
    lines.push('Next step: inspect doctor findings above and rerun the relevant setup command.');
    lines.push(
      'Need to decide which surface to use after bootstrap? Run `pnpm kyberion setup report --persona first-time-user`.'
    );
    if (onDemandActuator) {
      lines.push(
        `For actuator-level pulls, run \`pnpm deps:check --actuator ${onDemandActuator}\` before starting that surface.`
      );
    }
  }
  return lines.join('\n');
}

export const DOCTOR_CLI: CliGuardSpec = {
  command: 'pnpm run doctor',
  manifestId: 'script.doctor',
  options: [
    { flag: '--manifest', value: '<path>' },
    { flag: '--runtime', value: '<app|meeting|voice|browser|baseline>' },
    { flag: '--all' },
    { flag: '--mission', value: '<id>' },
    { flag: '--platform', value: '<ios|android|all>' },
    { flag: '--full' },
    { flag: '--json' },
  ],
};

export const runDoctor = defineScript<DoctorRunReport | undefined>({
  name: 'doctor',
  async run(context: ScriptContext): Promise<DoctorRunReport | undefined> {
    // CU-01: `--help` prints usage and exits 0 without running any probe.
    if (hasHelpFlag(context.argv)) {
      context.print(formatCliUsage(DOCTOR_CLI));
      return undefined;
    }
    const argv = await parseDoctorArguments(context.argv);
    const report = await collectDoctorReport(argv);
    context.print(context.json ? report : formatDoctorReport(report, argv));
    if (report.totalMissing > 0) {
      throw new ScriptExitError(1, '', true, report);
    }
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'run_doctor.ts') ||
  isDirectScript(import.meta.url, 'run_doctor.js')
)
  void runDoctor();
