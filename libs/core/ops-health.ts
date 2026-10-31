/**
 * ops-health — pure verdicts over the resident operations state.
 *
 * Baseline L10 used to judge the scheduler by "heartbeat fresh + at least one
 * lastRun fleet-wide in 24h". A crash-looping chronos rewrites its heartbeat
 * on every restart and one stray run satisfies the fleet check, so the layer
 * looked alive while every individual schedule stalled; failed schedules only
 * raised an alert and never changed the status. This evaluator turns the raw
 * observations (schedule registry, chronos heartbeat incl. restart counters,
 * backup archive + restore-drill receipt, janitor markers, installed OS units,
 * trigger delivery store size) into per-item findings that the baseline (L10 /
 * L12) and `pnpm kyberion doctor` both render, so the two surfaces can never
 * disagree on thresholds.
 *
 * Pure: no I/O and no wall clock — callers gather the input (see
 * scripts/lib/ops-health-input.ts) and pass `now`.
 */
import { matchesCron } from './pipeline/cron-utils.js';
import type { InstalledUnit, InstalledUnitsReport } from './daemon/installed-units.js';

export type { InstalledUnit, InstalledUnitsReport };

export type OpsHealthSeverity = 'warn' | 'error';

export interface OpsHealthFinding {
  /** Stable id, `<kind>` or `<kind>:<subject>`. */
  id: string;
  severity: OpsHealthSeverity;
  reason: string;
  /** A concrete command the operator can run next. */
  next: string;
  evidence?: string[];
}

export interface OpsHealthReport {
  findings: OpsHealthFinding[];
}

/** Grace after a cron occurrence before the schedule counts as overdue. */
export const CRON_OVERDUE_GRACE_MS = 2 * 60 * 60 * 1000;
/** Lookback for the most recent cron occurrence (covers weekly schedules). */
export const CRON_OVERDUE_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;
/** More restarts than this within the trailing hour is a crash loop. */
export const CRASH_LOOP_RESTARTS_PER_HOUR = 3;
/** Backup archive freshness — matches summarizeBackupStatus's default. */
export const BACKUP_ARCHIVE_MAX_AGE_HOURS = 36;
/** The restore drill runs monthly; 35 days absorbs one late run. */
export const BACKUP_DRILL_MAX_AGE_MS = 35 * 24 * 60 * 60 * 1000;
/** Janitor marker freshness — 2x the daily maintenance TTL (AL-01). */
export const JANITOR_MARKER_MAX_AGE_MS = 48 * 60 * 60 * 1000;
/** Warn when the trigger delivery store reaches this share of its read cap. */
export const TRIGGER_STORE_WARN_RATIO = 0.8;
/** Schedule id of the daily encrypted backup (pipelines/backup-daily.json). */
export const BACKUP_DAILY_SCHEDULE_ID = 'backup-daily';

export interface OpsHealthScheduleEntry {
  id: string;
  enabled: boolean;
  pipelinePath?: string;
  trigger: { type: 'cron' | 'interval'; cron?: string; intervalMs?: number; timezone?: string };
  lastRun?: string;
  lastStatus?: 'succeeded' | 'failed';
  consecutiveFailures?: number;
  disabledReason?: string;
}

export interface ChronosHeartbeatObservation {
  /** Freshness verdict from readDaemonHeartbeat. */
  status: 'healthy' | 'stale' | 'missing' | 'malformed';
  /** Status the daemon itself wrote (`starting` | `running` | `stopping` | `error`). */
  process_status?: string | null;
  pid?: number | null;
  started_at?: string | null;
  restarts_1h?: number | null;
  restarts_24h?: number | null;
  last_tick_ok_at?: string | null;
  last_tick_error?: string | null;
  last_tick_error_at?: string | null;
}

export interface OpsHealthBackupSummary {
  status: 'missing' | 'stale' | 'fresh';
  latestName: string | null;
  latestAgeHours: number | null;
  backupDir?: string;
}

/** `active/shared/runtime/state/backup-drill-last.json` */
export interface BackupDrillReceipt {
  completed_at: string;
  archive: string | null;
  ok: boolean;
  /** `no_archive`: the drill was skipped because no backup archive exists yet. */
  reason?: 'no_archive' | 'failed';
  error?: string;
}

export interface JanitorFailureMarker {
  failed_at: string;
  exit_code: number | null;
  log_path?: string;
  error?: string;
}

export interface OpsHealthJanitorObservation {
  last_run_ms: number | null;
  last_failure?: JanitorFailureMarker | null;
}

/** One entry of knowledge/product/governance/resident-services.json. */
export interface ResidentServiceDesired {
  id: string;
  requirement: 'required' | 'optional';
  /** Surface that runs the service whenever it is enabled (no OS unit then). */
  owner_surface?: string;
}

/** describeBackupPassphraseAvailability result (scripts/lib/backup-passphrase.ts); never the value. */
export interface BackupPassphraseObservation {
  available: boolean;
  source: 'env' | 'secret' | null;
  backend?: string;
  reason?: string;
}

export const BACKUP_PASSPHRASE_INTRODUCE_COMMAND =
  'pnpm kyberion secret introduce kyberion-backup PASSPHRASE';

export interface OpsHealthTriggerStore {
  path: string;
  size_bytes: number;
  cap_bytes: number;
}

export interface OpsHealthInput {
  /** Registry entries; null when the registry could not be read. */
  schedules: OpsHealthScheduleEntry[] | null;
  /** Enabled schedules declared by pipeline ADFs (`schedule.enabled !== false`). */
  declaredEnabledScheduleCount: number;
  /** Enabled schedules the operator allowlist keeps from running on this host. */
  excludedScheduleIds?: string[];
  heartbeat: ChronosHeartbeatObservation | null;
  backup: OpsHealthBackupSummary | null;
  drillReceipt: BackupDrillReceipt | null;
  janitor: OpsHealthJanitorObservation | null;
  /** null = not inspected (unsupported platform or inspector unavailable). */
  installedUnits: InstalledUnitsReport | null;
  residentServices: ResidentServiceDesired[];
  /** Ids of enabled runtime surfaces (active-surfaces.json). */
  enabledSurfaces: string[];
  triggerStore?: OpsHealthTriggerStore | null;
  /** Probed only when backup-daily is enabled; null/undefined = not probed. */
  backupPassphrase?: BackupPassphraseObservation | null;
}

export interface OpsHealthOptions {
  cronMatcher?: (cron: string, date: Date, timezone?: string) => boolean;
}

/** Fallback when resident-services.json cannot be read (mirrors its shipped content). */
export const DEFAULT_RESIDENT_SERVICES: readonly ResidentServiceDesired[] = Object.freeze([
  { id: 'chronos', requirement: 'required' },
  { id: 'daemon-watchdog', requirement: 'required' },
  { id: 'agent-runtime-supervisor', requirement: 'optional' },
  { id: 'generation-schedule', requirement: 'optional', owner_surface: 'generation-schedule' },
]);

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function hours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * Most recent cron occurrence `t` with `lastRun < t <= ceiling`, scanning back
 * minute by minute and stopping at lastRun (so healthy schedules stay cheap).
 */
export function latestMissedCronOccurrence(
  cron: string,
  timezone: string | undefined,
  ceilingMs: number,
  floorMs: number,
  matcher: (cron: string, date: Date, timezone?: string) => boolean = matchesCron
): number | null {
  const cursor = new Date(ceilingMs);
  cursor.setSeconds(0, 0);
  while (cursor.getTime() > floorMs) {
    if (matcher(cron, cursor, timezone)) return cursor.getTime();
    cursor.setMinutes(cursor.getMinutes() - 1);
  }
  return null;
}

function scheduleFindings(
  input: OpsHealthInput,
  nowMs: number,
  options: OpsHealthOptions
): OpsHealthFinding[] {
  const findings: OpsHealthFinding[] = [];
  const schedules = input.schedules ?? [];
  const excluded = new Set(input.excludedScheduleIds ?? []);
  const startedAtMs = parseMs(input.heartbeat?.started_at);
  const matcher = options.cronMatcher ?? matchesCron;

  for (const schedule of schedules) {
    const runCommand = schedule.pipelinePath
      ? `pnpm pipeline --input ${schedule.pipelinePath}`
      : 'pnpm kyberion scheduler status';
    const consecutiveFailures = Number(schedule.consecutiveFailures ?? 0) || 0;
    const autoDisabled = !schedule.enabled && typeof schedule.disabledReason === 'string';
    if (schedule.lastStatus === 'failed' || consecutiveFailures > 0 || autoDisabled) {
      const evidence = [
        `lastStatus=${schedule.lastStatus ?? 'unknown'}`,
        `consecutiveFailures=${consecutiveFailures}`,
        ...(schedule.lastRun ? [`lastRun=${schedule.lastRun}`] : []),
        ...(autoDisabled ? [`disabledReason=${schedule.disabledReason}`] : []),
      ];
      findings.push({
        id: `schedule-failing:${schedule.id}`,
        severity: 'error',
        reason: autoDisabled
          ? `schedule ${schedule.id} was auto-disabled after failures (${schedule.disabledReason})`
          : `schedule ${schedule.id} is failing (last status ${schedule.lastStatus ?? 'unknown'}, ${consecutiveFailures} consecutive failure(s))`,
        next: `${runCommand}  # reproduce the failure, then fix and let chronos retry`,
        evidence,
      });
    }

    if (!schedule.enabled || excluded.has(schedule.id)) continue;
    const lastRunMs = parseMs(schedule.lastRun);
    let dueMs: number | null = null;
    let graceMs = CRON_OVERDUE_GRACE_MS;
    if (schedule.trigger.type === 'cron' && schedule.trigger.cron) {
      const ceiling = nowMs - CRON_OVERDUE_GRACE_MS;
      const floor = Math.max(lastRunMs ?? -Infinity, nowMs - CRON_OVERDUE_LOOKBACK_MS);
      dueMs = latestMissedCronOccurrence(
        schedule.trigger.cron,
        schedule.trigger.timezone,
        ceiling,
        floor,
        matcher
      );
    } else if (schedule.trigger.type === 'interval') {
      const intervalMs = Number(schedule.trigger.intervalMs || 0);
      if (intervalMs > 0) {
        graceMs = intervalMs;
        const candidate = lastRunMs === null ? null : lastRunMs + intervalMs;
        if (candidate !== null && nowMs - candidate > intervalMs) dueMs = candidate;
        if (lastRunMs === null && startedAtMs !== null && nowMs - startedAtMs > intervalMs) {
          dueMs = startedAtMs;
        }
      }
    }
    if (dueMs === null) continue;
    // A scheduler that started after the missed occurrence (plus grace) has
    // not had its chance yet — do not flag it as overdue on first boot.
    if (startedAtMs !== null && nowMs - startedAtMs < graceMs) continue;
    findings.push({
      id: `schedule-overdue:${schedule.id}`,
      severity: 'warn',
      reason: `schedule ${schedule.id} missed its run due at ${new Date(dueMs).toISOString()} (${hours(nowMs - dueMs)} ago; last run ${schedule.lastRun ?? 'never'})`,
      next: `pnpm kyberion scheduler status  # confirm chronos is ticking, then: ${runCommand}`,
      evidence: [
        `trigger=${schedule.trigger.type === 'cron' ? schedule.trigger.cron : `${schedule.trigger.intervalMs}ms`}`,
        `lastRun=${schedule.lastRun ?? 'never'}`,
      ],
    });
  }

  if (input.schedules !== null && input.declaredEnabledScheduleCount > 0) {
    const enabledRegistered = schedules.filter((schedule) => schedule.enabled).length;
    if (enabledRegistered === 0) {
      findings.push({
        id: 'schedule-registry-empty',
        severity: 'error',
        reason: `${input.declaredEnabledScheduleCount} pipeline(s) declare an enabled schedule but the registry has no enabled entry — chronos has never synced them`,
        next: 'pnpm kyberion scheduler install --apply  # or run `pnpm scheduler` once to sync',
        evidence: [`declared_enabled=${input.declaredEnabledScheduleCount}`],
      });
    }
  }
  return findings;
}

function heartbeatFindings(input: OpsHealthInput): OpsHealthFinding[] {
  const heartbeat = input.heartbeat;
  if (!heartbeat) return [];
  const findings: OpsHealthFinding[] = [];
  const restarts1h = Number(heartbeat.restarts_1h ?? 0) || 0;
  if (restarts1h > CRASH_LOOP_RESTARTS_PER_HOUR) {
    findings.push({
      id: 'scheduler-crash-loop',
      severity: 'error',
      reason: `chronos restarted ${restarts1h} time(s) in the last hour (${heartbeat.restarts_24h ?? '?'} in 24h) — it is crash-looping and its fresh heartbeat is not evidence of liveness`,
      next: 'pnpm kyberion scheduler status  # read the error log it prints, fix the cause, then `pnpm kyberion scheduler restart --apply`',
      evidence: [
        `started_at=${heartbeat.started_at ?? 'unknown'}`,
        ...(heartbeat.last_tick_error ? [`last_tick_error=${heartbeat.last_tick_error}`] : []),
      ],
    });
  }
  const errorAtMs = parseMs(heartbeat.last_tick_error_at);
  const okAtMs = parseMs(heartbeat.last_tick_ok_at);
  if (
    heartbeat.process_status === 'error' ||
    (errorAtMs !== null && (okAtMs === null || errorAtMs > okAtMs))
  ) {
    findings.push({
      id: 'scheduler-tick-failing',
      severity: 'error',
      reason: `chronos's last tick failed${heartbeat.last_tick_error ? `: ${heartbeat.last_tick_error}` : ''} (last successful tick ${heartbeat.last_tick_ok_at ?? 'never'})`,
      next: 'pnpm kyberion scheduler status  # inspect the error log, then `pnpm kyberion scheduler restart --apply`',
      evidence: [
        `process_status=${heartbeat.process_status ?? 'unknown'}`,
        ...(heartbeat.last_tick_error_at
          ? [`last_tick_error_at=${heartbeat.last_tick_error_at}`]
          : []),
      ],
    });
  }
  return findings;
}

function backupFindings(input: OpsHealthInput, nowMs: number): OpsHealthFinding[] {
  const findings: OpsHealthFinding[] = [];
  const backupCommand = 'pnpm pipeline --input pipelines/backup-daily.json';
  const backup = input.backup;
  if (backup?.status === 'missing') {
    findings.push({
      id: 'backup-archive-missing',
      severity: 'error',
      reason: 'no backup archive exists',
      next: `${backupCommand}  # needs KYBERION_BACKUP_PASSPHRASE`,
      ...(backup.backupDir ? { evidence: [`dir=${backup.backupDir}`] } : {}),
    });
  } else if (
    backup &&
    backup.latestAgeHours !== null &&
    backup.latestAgeHours > BACKUP_ARCHIVE_MAX_AGE_HOURS
  ) {
    findings.push({
      id: 'backup-archive-stale',
      severity: 'warn',
      reason: `latest backup archive is ${backup.latestAgeHours.toFixed(1)}h old (limit ${BACKUP_ARCHIVE_MAX_AGE_HOURS}h)`,
      next: `${backupCommand}  # needs KYBERION_BACKUP_PASSPHRASE`,
      evidence: [`latest=${backup.latestName ?? 'unknown'}`],
    });
  }

  const backupDaily = (input.schedules ?? []).find(
    (schedule) => schedule.id === BACKUP_DAILY_SCHEDULE_ID
  );
  if (backupDaily?.lastStatus === 'failed') {
    findings.push({
      id: 'backup-daily-failed',
      severity: 'error',
      reason: `the ${BACKUP_DAILY_SCHEDULE_ID} schedule failed its last run (${backupDaily.lastRun ?? 'unknown'})`,
      next: `${backupCommand}  # reproduce; usually KYBERION_BACKUP_PASSPHRASE is missing in the daemon env`,
      evidence: [`consecutiveFailures=${backupDaily.consecutiveFailures ?? 0}`],
    });
  }

  const passphrase = input.backupPassphrase;
  if (passphrase && !passphrase.available) {
    findings.push({
      id: 'backup-passphrase-unavailable',
      severity: 'error',
      reason:
        'backup-daily is enabled but no backup passphrase is reachable (env or OS keychain / secret resolver) — every encrypted backup will fail',
      next: BACKUP_PASSPHRASE_INTRODUCE_COMMAND,
      ...(passphrase.reason ? { evidence: [passphrase.reason] } : {}),
    });
  }

  const drillCommand = 'pnpm pipeline --input pipelines/backup-restore-drill.json';
  const receipt = input.drillReceipt;
  if (!receipt) {
    findings.push({
      id: 'backup-drill-missing',
      severity: 'warn',
      reason: 'no restore drill receipt — backups have never been proven restorable',
      next: drillCommand,
    });
  } else if (!receipt.ok && receipt.reason === 'no_archive') {
    findings.push({
      id: 'backup-drill-no-archive',
      severity: 'warn',
      reason: `the restore drill at ${receipt.completed_at} was skipped: no backup archive existed — ${BACKUP_DAILY_SCHEDULE_ID} must succeed before the drill can prove anything`,
      next: `${backupCommand}  # then ${drillCommand}`,
    });
  } else if (!receipt.ok) {
    findings.push({
      id: 'backup-drill-failed',
      severity: 'error',
      reason: `the last restore drill failed at ${receipt.completed_at}${receipt.error ? `: ${receipt.error}` : ''}`,
      next: drillCommand,
      evidence: [`archive=${receipt.archive ?? 'none'}`],
    });
  } else {
    const completedMs = parseMs(receipt.completed_at);
    if (completedMs === null || nowMs - completedMs > BACKUP_DRILL_MAX_AGE_MS) {
      findings.push({
        id: 'backup-drill-stale',
        severity: 'warn',
        reason: `the last successful restore drill (${receipt.completed_at}) is older than ${Math.round(BACKUP_DRILL_MAX_AGE_MS / 86_400_000)} days`,
        next: drillCommand,
        evidence: [`archive=${receipt.archive ?? 'none'}`],
      });
    }
  }
  return findings;
}

function janitorFindings(input: OpsHealthInput, nowMs: number): OpsHealthFinding[] {
  const janitor = input.janitor;
  if (!janitor) return [];
  const findings: OpsHealthFinding[] = [];
  const janitorCommand = 'pnpm pipeline --input pipelines/storage-janitor.json';
  const failure = janitor.last_failure ?? null;
  const failedAtMs = parseMs(failure?.failed_at);
  const failureIsCurrent =
    failure !== null &&
    failedAtMs !== null &&
    (janitor.last_run_ms === null || failedAtMs > janitor.last_run_ms);
  if (janitor.last_run_ms === null || nowMs - janitor.last_run_ms > JANITOR_MARKER_MAX_AGE_MS) {
    findings.push({
      id: 'janitor-stale',
      severity: 'warn',
      reason:
        janitor.last_run_ms === null
          ? 'the storage janitor has never completed a run (no last-run marker)'
          : `the storage janitor last completed ${hours(nowMs - janitor.last_run_ms)} ago (limit ${hours(JANITOR_MARKER_MAX_AGE_MS)})`,
      next: janitorCommand,
      ...(failureIsCurrent
        ? {
            evidence: [
              `last_failure=${failure!.failed_at} exit=${failure!.exit_code ?? 'unknown'}`,
              ...(failure!.log_path ? [`log=${failure!.log_path}`] : []),
            ],
          }
        : {}),
    });
  }
  if (failureIsCurrent) {
    findings.push({
      id: 'janitor-failed',
      severity: 'warn',
      reason: `the baseline-submitted janitor run failed at ${failure!.failed_at} (exit ${failure!.exit_code ?? 'unknown'})${failure!.error ? `: ${failure!.error}` : ''}`,
      next: `${janitorCommand}  # reproduce in the foreground${failure!.log_path ? `; log: ${failure!.log_path}` : ''}`,
      ...(failure!.log_path ? { evidence: [`log=${failure!.log_path}`] } : {}),
    });
  }
  return findings;
}

function unitFindings(input: OpsHealthInput): OpsHealthFinding[] {
  const report = input.installedUnits;
  if (!report) return [];
  const findings: OpsHealthFinding[] = [];
  const enabledSurfaces = new Set(input.enabledSurfaces);
  for (const desired of input.residentServices) {
    const units = report.units.filter((unit) => unit.id === desired.id);
    const owned = units.filter((unit) => unit.ownedByThisCheckout);
    const surfaceRunsIt = Boolean(
      desired.owner_surface && enabledSurfaces.has(desired.owner_surface)
    );
    if (desired.requirement === 'required' && owned.length === 0 && !surfaceRunsIt) {
      findings.push({
        id: `unit-missing:${desired.id}`,
        severity: 'error',
        reason: `required resident service ${desired.id} has no OS unit for this checkout`,
        next: `pnpm kyberion scheduler install${desired.id === 'chronos' ? '' : ` --daemon ${desired.id}`} --apply`,
        evidence: [`instance=${report.instanceId}`, `repoRoot=${report.repoRoot}`],
      });
    }
    if (surfaceRunsIt && owned.length > 0) {
      findings.push({
        id: `unit-double-owner:${desired.id}`,
        severity: 'warn',
        reason: `${desired.id} is installed as an OS unit while surface ${desired.owner_surface} also runs it — two owners will double-fire`,
        next: `pnpm kyberion scheduler uninstall --daemon ${desired.id} --apply  # or disable the surface and run \`pnpm surfaces reconcile\``,
        evidence: owned.map((unit) => `unit=${unit.label}`),
      });
    }
  }
  for (const unit of report.units) {
    if (unit.repoRoot !== null && unit.repoRoot !== report.repoRoot && unit.ownedByThisCheckout) {
      findings.push({
        id: `unit-foreign-root:${unit.id}`,
        severity: 'error',
        reason: `unit ${unit.label} points at ${unit.repoRoot}, not this checkout (${report.repoRoot})`,
        next: 'pnpm kyberion scheduler reconcile --apply',
        evidence: [`scope=${unit.scope}`],
      });
    }
    if (unit.scope === 'legacy' && unit.ownedByThisCheckout) {
      findings.push({
        id: `unit-legacy-owned:${unit.id}`,
        severity: 'warn',
        reason: `legacy global unit ${unit.label} runs this checkout — migrate it to the checkout-scoped unit`,
        next: 'pnpm kyberion scheduler reconcile --apply',
        evidence: [`repoRoot=${unit.repoRoot ?? 'unknown'}`],
      });
    }
  }
  return findings;
}

function triggerStoreFindings(input: OpsHealthInput): OpsHealthFinding[] {
  const store = input.triggerStore;
  if (!store || store.cap_bytes <= 0) return [];
  const ratio = store.size_bytes / store.cap_bytes;
  if (ratio < TRIGGER_STORE_WARN_RATIO) return [];
  return [
    {
      id: 'trigger-store-near-cap',
      severity: ratio >= 1 ? 'error' : 'warn',
      reason: `trigger delivery store is ${(ratio * 100).toFixed(0)}% of its ${(store.cap_bytes / 1_048_576).toFixed(0)}MB read cap — past the cap, reads fail and idempotency is lost`,
      next: 'pnpm daemon:watchdog -- --json  # confirm delivery health, then run `pnpm pipeline --input pipelines/storage-janitor.json` to compact',
      evidence: [`path=${store.path}`, `size_bytes=${store.size_bytes}`],
    },
  ];
}

/** Evaluate every resident-ops observation into findings. Pure. */
export function evaluateOpsHealth(
  input: OpsHealthInput,
  now: Date,
  options: OpsHealthOptions = {}
): OpsHealthReport {
  const nowMs = now.getTime();
  return {
    findings: [
      ...scheduleFindings(input, nowMs, options),
      ...heartbeatFindings(input),
      ...backupFindings(input, nowMs),
      ...janitorFindings(input, nowMs),
      ...unitFindings(input),
      ...triggerStoreFindings(input),
    ],
  };
}

/** Findings that make the scheduler layer (L10) fail. */
export function isSchedulerOpsFinding(finding: OpsHealthFinding): boolean {
  return /^(schedule-overdue|schedule-failing|schedule-registry-empty|scheduler-crash-loop|scheduler-tick-failing):?/.test(
    finding.id
  );
}

/** One verdict line per finding, for doctor and CLI renderers. */
export function formatOpsHealthFinding(finding: OpsHealthFinding): string {
  const marker = finding.severity === 'error' ? 'ERROR' : 'WARN';
  return `${marker} ${finding.id}: ${finding.reason} | next: ${finding.next}`;
}
