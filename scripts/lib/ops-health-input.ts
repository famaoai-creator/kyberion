/**
 * scripts/lib/ops-health-input.ts — gather the observations evaluateOpsHealth
 * (libs/core/ops-health.ts) judges. Shared by the baseline check (L10/L12)
 * and `pnpm kyberion doctor`, so both surfaces read the same state with the
 * same thresholds. Every reader fails soft: an unreadable source becomes
 * `null` (the evaluator then skips that family) instead of throwing.
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReaddir, safeStat } from '@agent/core/secure-io';
import { isVitestProcess, readJsonIfPresent } from '@agent/core/foundation';
import { readDaemonHeartbeat, type DaemonHeartbeatStatus } from '@agent/core/daemon-heartbeat';
import {
  listOperatorExcludedSchedules,
  loadScheduleRegistry,
  type ScheduledPipeline,
} from '@agent/core/pipeline-scheduler';
import { readJanitorLastRunMs } from '@agent/core/storage-janitor';
import { loadSurfaceManifest } from '@agent/core/surface/surface-runtime';
import { inspectInstalledUnits } from '@agent/core/daemon/installed-units';
import { loadResidentServicesPolicy } from '@agent/core/daemon/resident-services';
import {
  BACKUP_ARCHIVE_MAX_AGE_HOURS,
  DEFAULT_RESIDENT_SERVICES,
  type BackupPassphraseObservation,
  type ChronosHeartbeatObservation,
  type InstalledUnitsReport,
  type OpsHealthInput,
  type ResidentServiceDesired,
} from '@agent/core/ops-health';
import { readBackupDrillReceipt, readJanitorFailureMarker } from '@agent/core/ops-health-state';
import { summarizeBackupStatus } from '../backup.js';
import { describeBackupPassphraseAvailability } from './backup-passphrase.js';
import { loadBaselineCache, storeBaselineCache } from '@agent/core/baseline-check-cache';
import { TRIGGER_STORE_GROWTH_WARN_BYTES } from '@agent/core/trigger-runner';

export const CHRONOS_HEARTBEAT_ID = 'chronos-daemon';
export const CHRONOS_HEARTBEAT_MAX_AGE_MS = 10 * 60 * 1000;
/** Trigger delivery store (trigger-runner.ts DEFAULT_STORE_PATH), relative to the shared floor. */
export const TRIGGER_DELIVERY_STORE_SUBPATH = 'runtime/trigger-deliveries.jsonl';
/** Growth warning level of the trigger delivery store (a warning, never an append cap). */
export const TRIGGER_DELIVERY_STORE_WARN_BYTES = TRIGGER_STORE_GROWTH_WARN_BYTES;
/** A reachable passphrase is re-probed at most this often (one keychain read, up to 10s). */
export const BACKUP_PASSPHRASE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const BACKUP_DAILY_ID = 'backup-daily';

/** Project a heartbeat read into the evaluator's observation (incl. restart counters). */
export function toChronosHeartbeatObservation(
  status: DaemonHeartbeatStatus
): ChronosHeartbeatObservation {
  const details = (status.heartbeat?.details ?? {}) as Record<string, unknown>;
  const text = (key: string): string | null =>
    typeof details[key] === 'string' ? (details[key] as string) : null;
  const num = (key: string): number | null =>
    typeof details[key] === 'number' && Number.isFinite(details[key])
      ? (details[key] as number)
      : null;
  return {
    status: status.status,
    process_status: status.heartbeat?.status ?? null,
    pid: status.heartbeat?.pid ?? null,
    started_at: text('started_at'),
    restarts_1h: num('restarts_1h'),
    restarts_24h: num('restarts_24h'),
    last_tick_ok_at: text('last_tick_ok_at'),
    last_tick_error: text('last_tick_error'),
    last_tick_error_at: text('last_tick_error_at'),
    phase: text('phase'),
    tick_started_at: text('tick_started_at'),
  };
}

/** Enabled schedules declared by repository pipeline ADFs (tenant files are not counted). */
export function countDeclaredEnabledSchedules(
  pipelinesDir = pathResolver.rootResolve('pipelines')
): number {
  let count = 0;
  const walk = (dir: string): void => {
    if (!safeExistsSync(dir)) return;
    for (const name of safeReaddir(dir)) {
      const full = path.join(dir, name);
      const stat = safeLstat(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.json') || name.startsWith('_')) continue;
      try {
        const adf = readJsonIfPresent<{
          action?: unknown;
          schedule?: { cron?: unknown; enabled?: unknown };
        }>(full);
        if (
          adf?.action === 'pipeline' &&
          typeof adf.schedule?.cron === 'string' &&
          adf.schedule.enabled !== false
        ) {
          count += 1;
        }
      } catch {
        // malformed pipeline JSON is the pipeline gates' concern, not ops health
      }
    }
  };
  walk(pipelinesDir);
  return count;
}

/** Desired resident services (resident-services.json); built-in fallback when unreadable. */
export function loadResidentServicesDesired(
  load: typeof loadResidentServicesPolicy = loadResidentServicesPolicy
): ResidentServiceDesired[] {
  try {
    return load().services.map((service) => ({
      id: service.id,
      requirement: service.requirement,
      ...(service.owner_surface ? { owner_surface: service.owner_surface } : {}),
    }));
  } catch {
    return [...DEFAULT_RESIDENT_SERVICES];
  }
}

function enabledSurfaceIds(): string[] {
  try {
    return loadSurfaceManifest()
      .surfaces.filter((surface) => surface.enabled !== false)
      .map((surface) => surface.id);
  } catch {
    return [];
  }
}

/**
 * Installed OS units (libs/core/daemon/installed-units.ts). null when the
 * platform is not inspected or inspection fails — unit findings are then
 * skipped rather than reporting every required unit as missing.
 */
export function inspectInstalledUnitsSafe(
  inspect: () => InstalledUnitsReport = () => inspectInstalledUnits()
): InstalledUnitsReport | null {
  try {
    const report = inspect();
    return report.platform === 'unsupported' ? null : report;
  } catch {
    return null;
  }
}

function triggerStoreObservation(): OpsHealthInput['triggerStore'] {
  try {
    const storePath = pathResolver.shared(TRIGGER_DELIVERY_STORE_SUBPATH);
    if (!safeExistsSync(storePath)) return null;
    return {
      path: path.relative(pathResolver.rootDir(), storePath),
      size_bytes: safeStat(storePath).size,
      warn_bytes: TRIGGER_DELIVERY_STORE_WARN_BYTES,
    };
  } catch {
    return null;
  }
}

export interface BackupPassphraseProbeDeps {
  probe?: () => BackupPassphraseObservation;
  loadCached?: () => BackupPassphraseObservation | null;
  storeCached?: (value: BackupPassphraseObservation) => void;
}

/**
 * Passphrase availability with a session cache: only a reachable result from
 * the OS keychain / secret resolver (`source: 'secret'`) is cached (6h), so
 * `pnpm kyberion secret introduce ...` is seen on the next run while hourly
 * baselines skip the keychain read once it is known good. An `env` result is
 * never cached: it reflects the shell that ran the probe, not the daemon env
 * backup-daily runs in.
 */
export function probeBackupPassphraseCached(
  deps: BackupPassphraseProbeDeps = {}
): BackupPassphraseObservation {
  const loadCached =
    deps.loadCached ??
    (() => loadBaselineCache<BackupPassphraseObservation>('backup-passphrase')?.value ?? null);
  const cached = (() => {
    try {
      return loadCached();
    } catch {
      return null;
    }
  })();
  if (cached?.available && cached.source === 'secret') return cached;
  const result = (deps.probe ?? (() => describeBackupPassphraseAvailability()))();
  if (result.available && result.source === 'secret') {
    try {
      (
        deps.storeCached ??
        ((value) => storeBaselineCache('backup-passphrase', value, BACKUP_PASSPHRASE_CACHE_TTL_MS))
      )({
        available: true,
        source: result.source,
        ...(result.backend ? { backend: result.backend } : {}),
      });
    } catch {
      // cache is an optimization only
    }
  }
  return result;
}

/** Probe only when backup-daily is enabled — otherwise no passphrase is promised. */
export function backupDailyEnabled(schedules: readonly ScheduledPipeline[] | null): boolean {
  return Boolean(
    schedules?.some((schedule) => schedule.id === BACKUP_DAILY_ID && schedule.enabled)
  );
}

export interface CollectOpsHealthInputOptions {
  now?: Date;
  /** Pre-read registry (baseline already loads it). */
  schedules?: ScheduledPipeline[] | null;
  heartbeat?: DaemonHeartbeatStatus;
  /** Skip OS unit inspection (tests, or callers without host access). */
  inspectUnits?: boolean;
  /** Probe the backup passphrase (default: not under vitest). */
  probeBackupPassphrase?: boolean;
  passphrase?: BackupPassphraseProbeDeps;
}

export async function collectOpsHealthInput(
  options: CollectOpsHealthInputOptions = {}
): Promise<OpsHealthInput> {
  const now = options.now ?? new Date();
  let schedules: ScheduledPipeline[] | null = options.schedules ?? null;
  if (options.schedules === undefined) {
    try {
      schedules = loadScheduleRegistry().schedules;
    } catch {
      schedules = null;
    }
  }
  const heartbeat =
    options.heartbeat ??
    readDaemonHeartbeat(CHRONOS_HEARTBEAT_ID, {
      staleAfterMs: CHRONOS_HEARTBEAT_MAX_AGE_MS,
      now,
    });
  let backup: OpsHealthInput['backup'] = null;
  try {
    const summary = summarizeBackupStatus(undefined, {
      staleAfterHours: BACKUP_ARCHIVE_MAX_AGE_HOURS,
      now,
    });
    backup = {
      status: summary.status,
      latestName: summary.latestName,
      latestAgeHours: summary.latestAgeHours,
      backupDir: summary.backupDir,
    };
  } catch {
    backup = null;
  }
  let declared = 0;
  try {
    declared = countDeclaredEnabledSchedules();
  } catch {
    declared = 0;
  }
  return {
    schedules,
    declaredEnabledScheduleCount: declared,
    excludedScheduleIds: schedules ? listOperatorExcludedSchedules(schedules) : [],
    heartbeat: toChronosHeartbeatObservation(heartbeat),
    backup,
    drillReceipt: readBackupDrillReceipt(),
    janitor: {
      last_run_ms: readJanitorLastRunMs(),
      last_failure: readJanitorFailureMarker(),
    },
    installedUnits: options.inspectUnits === false ? null : inspectInstalledUnitsSafe(),
    residentServices: loadResidentServicesDesired(),
    enabledSurfaces: enabledSurfaceIds(),
    triggerStore: triggerStoreObservation(),
    backupPassphrase:
      (options.probeBackupPassphrase ?? !isVitestProcess()) && backupDailyEnabled(schedules)
        ? probeBackupPassphraseCached(options.passphrase)
        : null,
  };
}
