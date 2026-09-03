import * as path from 'node:path';
import { SovereignSentinel } from '@agent/core/sovereign-sentinel';
import { validateService } from '@agent/core/service-validator';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { nowIso, parseSafeJsonInput, readJson } from '@agent/core/foundation';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import { logger } from '@agent/core/core';
import { withExecutionContext } from '@agent/core/authority';
import { loadServiceEndpointsCatalog } from '@agent/core/service-endpoint-registry';
import { killSwitch } from '@agent/core/kill-switch';
import {
  readJanitorLastRunMs,
  readJanitorLastSubmissionMs as readJanitorLastSubmissionMarkerMs,
  writeJanitorSubmissionMarker,
  readSchedulerOpsAlertDays,
  writeSchedulerOpsAlertDay,
} from '@agent/core/storage-janitor';
import { listOrphanNhiIdentities } from '@agent/core/nhi-lifecycle-governance';
import { readReasoningDegraded } from '@agent/core/reasoning-degradation';
import {
  readReasoningFailover,
  type ReasoningFailoverMarker,
} from '@agent/core/reasoning-failover';
import { validateEnv } from '@agent/core/env-validator';
import { secretGuard } from '@agent/core/secret-guard';
import {
  peekProviderCapabilityRegistry,
  loadProviderCapabilityRegistry,
  DEFAULT_PROVIDER_CAPABILITY_TTL_MS,
  type ProviderCapability,
} from '@agent/core/provider-capability-registry';
import { readDaemonHeartbeat, type DaemonHeartbeatStatus } from '@agent/core/daemon-heartbeat';
import { loadScheduleRegistry, type ScheduledPipeline } from '@agent/core/pipeline-scheduler';
import { matchesCron } from '@agent/core/src/cron-utils';
import {
  sendOpsAlert,
  resolveOpsAlertChannelStatus,
  type OpsAlertReceipt,
} from '@agent/core/ops-alert';
import {
  collectFailedSchedules,
  sweepFailedSchedules,
  type FailedScheduleFinding,
} from '@agent/core/src/feedback-loop';
import { enqueueOperationalLearningSignal } from '@agent/core/operational-learning';
import {
  loadNotificationPreferences,
  resolveOperatorNotificationRoute,
} from '@agent/core/operator-notifications';
import {
  hasRequiredServiceConnectionValue,
  loadServiceConnectionReadinessConfig,
} from '@agent/core/service-connection-readiness';
import {
  assessDesktopObservationReadiness,
  listDesktopObservationSources,
} from '@agent/core/desktop-recording';
import { macosAutomationBridge } from '@agent/core/macos-automation-bridge';
import { spawnManagedProcess } from '@agent/core/managed-process';
import { runCoworkHealthCheck } from '@agent/core/cowork-health-check';
import { scanTenantDrift } from './watch_tenant_drift.js';
import { defineScript, isDirectScript } from './lib/harness.js';

type ReadinessRule = {
  required_keys_any?: string[];
};

const BASELINE_CACHE_TTL_MS = 60 * 60 * 1000;
const BASELINE_CACHE_DIR = 'runtime/baseline-check-cache';
const JANITOR_MAINTENANCE_TTL_MS = 24 * 60 * 60 * 1000;

// AL-01: janitor liveness observation. The maintenance fallback above only
// re-submits the janitor job — it cannot see a submission machinery that is
// itself broken (job spawned but never completes). This freshness window is
// intentionally 2x the maintenance TTL: one missed daily run is absorbed by
// re-submission; a marker missing or older than 48h means the janitor is not
// actually running and the baseline must degrade to needs_attention (L8).
export const JANITOR_FRESHNESS_MAX_AGE_MS = 48 * 60 * 60 * 1000;

// EG-03: an active system with a silent audit ledger is not healthy.
export const AUDIT_LEDGER_FRESHNESS_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export interface AuditLedgerFreshness {
  fresh: boolean;
  last_entry_ms: number | null;
  age_ms: number | null;
  reason: string;
}

export function readAuditLedgerFreshness(
  auditDir = pathResolver.sharedLogsAudit(),
  nowMs = Date.now()
): AuditLedgerFreshness {
  try {
    const safeAuditDir = assertSafeRepositoryPath(auditDir, { allowMissingLeaf: true });
    if (!safeExistsSync(safeAuditDir) || !safeLstat(safeAuditDir).isDirectory()) {
      return { fresh: false, last_entry_ms: null, age_ms: null, reason: 'missing' };
    }
    const files = safeReaddir(safeAuditDir)
      .filter((entry) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(entry))
      .sort();
    let lastEntryMs: number | null = null;
    for (const file of files) {
      let safeFile: string;
      try {
        safeFile = assertSafeRepositoryPath(path.join(safeAuditDir, file), {
          allowMissingLeaf: true,
        });
      } catch {
        continue;
      }
      if (!safeExistsSync(safeFile) || !safeLstat(safeFile).isFile()) continue;
      const raw = String(safeReadFile(safeFile, { encoding: 'utf8' }) || '');
      for (const line of raw.split(/\r?\n/u).reverse()) {
        if (!line.trim()) continue;
        try {
          const timestamp = Date.parse(
            String(
              (parseSafeJsonInput(line, 'baseline audit entry') as { timestamp?: unknown })
                .timestamp || ''
            )
          );
          if (Number.isFinite(timestamp)) {
            lastEntryMs = Math.max(lastEntryMs ?? 0, timestamp);
            break;
          }
        } catch {
          // audit:verify owns corruption classification; freshness remains observable.
        }
      }
    }
    const ageMs = lastEntryMs === null ? null : Math.max(0, nowMs - lastEntryMs);
    return {
      fresh: ageMs !== null && ageMs <= AUDIT_LEDGER_FRESHNESS_MAX_AGE_MS,
      last_entry_ms: lastEntryMs,
      age_ms: ageMs,
      reason:
        lastEntryMs === null
          ? 'missing'
          : ageMs! <= AUDIT_LEDGER_FRESHNESS_MAX_AGE_MS
            ? 'fresh'
            : 'stale',
    };
  } catch (error) {
    return {
      fresh: false,
      last_entry_ms: null,
      age_ms: null,
      reason: `audit freshness check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Pure freshness predicate for the janitor last-run marker
 * (`active/shared/runtime/state/janitor-last-run.json`). A missing marker
 * (null) is stale by definition — "never ran" must not look healthy.
 */
export function isJanitorMarkerFresh(lastRunMs: number | null, nowMs = Date.now()): boolean {
  return lastRunMs !== null && nowMs - lastRunMs <= JANITOR_FRESHNESS_MAX_AGE_MS;
}

// ---------------------------------------------------------------------------
// LC-01a: scheduler liveness (L10). The chronos daemon is the only scheduler;
// when it dies, 25 declared schedules silently stop firing and nothing else
// in the system notices (checkScheduleHealth only runs from
// recordPipelineResult, i.e. only when a schedule actually fires). The
// baseline check is the one thing that reliably runs at session start, so
// scheduler liveness degrades it to needs_attention — never fatal.
// ---------------------------------------------------------------------------

export const CHRONOS_DAEMON_ID = 'chronos-daemon';
// The daemon ticks every 60s; 10 minutes is deliberately generous (10x tick)
// so a slow tick or a single missed write never flaps the baseline.
export const SCHEDULER_HEARTBEAT_MAX_AGE_MS = 10 * 60 * 1000;
export const SCHEDULES_FIRING_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SchedulerHealthCheck {
  ok: boolean;
  reason: string | null;
}

export interface SchedulerHealthReport {
  enabled_schedule_count: number;
  scheduler_alive: SchedulerHealthCheck;
  schedules_firing: SchedulerHealthCheck & { due_in_window: number; last_run_in_window: number };
  healthy: boolean;
}

export function schedulerHealthEvaluationFailure(reason: string): SchedulerHealthReport {
  const detail = `scheduler health evaluation failed: ${reason}`;
  return {
    enabled_schedule_count: 0,
    scheduler_alive: { ok: false, reason: detail },
    schedules_firing: {
      ok: false,
      reason: detail,
      due_in_window: 0,
      last_run_in_window: 0,
    },
    healthy: false,
  };
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Pure: would this cron expression have matched at least one minute within
 * the trailing window ending at `now`? Minute-resolution scan (a 24h window
 * is 1440 matchesCron calls — negligible for a health check).
 */
export function cronFiredWithinWindow(
  cron: string,
  timezone: string | undefined,
  now: Date,
  windowMs: number,
  matcher: (cron: string, date: Date, timezone?: string) => boolean = matchesCron
): boolean {
  const cursor = new Date(now.getTime());
  cursor.setSeconds(0, 0);
  const floorMs = now.getTime() - windowMs;
  while (cursor.getTime() >= floorMs) {
    if (matcher(cron, cursor, timezone)) return true;
    cursor.setMinutes(cursor.getMinutes() - 1);
  }
  return false;
}

/**
 * Pure evaluation of the two L10 checks. Semantics:
 * - A fresh environment with zero enabled schedules is HEALTHY regardless of
 *   daemon state (nothing was promised, nothing is broken).
 * - With >=1 enabled schedule, `scheduler_alive` requires a fresh heartbeat
 *   whose pid is actually alive.
 * - `schedules_firing` requires, when at least one enabled schedule was due
 *   within the trailing 24h window, that at least one lastRun landed in that
 *   window.
 */
export function evaluateSchedulerHealth(input: {
  schedules: ScheduledPipeline[];
  heartbeat: DaemonHeartbeatStatus;
  pidAlive?: (pid: number) => boolean;
  now: Date;
  windowMs?: number;
  cronFired?: (cron: string, timezone: string | undefined, now: Date, windowMs: number) => boolean;
}): SchedulerHealthReport {
  const windowMs = input.windowMs ?? SCHEDULES_FIRING_WINDOW_MS;
  const pidAlive = input.pidAlive ?? isPidAlive;
  const cronFired = input.cronFired ?? cronFiredWithinWindow;
  const enabled = input.schedules.filter((schedule) => schedule.enabled);

  if (enabled.length === 0) {
    const reason = 'no enabled schedules registered';
    return {
      enabled_schedule_count: 0,
      scheduler_alive: { ok: true, reason },
      schedules_firing: { ok: true, reason, due_in_window: 0, last_run_in_window: 0 },
      healthy: true,
    };
  }

  let schedulerAlive: SchedulerHealthCheck = { ok: true, reason: null };
  const heartbeat = input.heartbeat;
  if (heartbeat.status !== 'healthy') {
    schedulerAlive = {
      ok: false,
      reason: `heartbeat ${heartbeat.status}${heartbeat.reason ? `: ${heartbeat.reason}` : ''}`,
    };
  } else if (!heartbeat.heartbeat || !pidAlive(heartbeat.heartbeat.pid)) {
    schedulerAlive = {
      ok: false,
      reason: `heartbeat pid ${heartbeat.heartbeat?.pid ?? 'unknown'} is not alive`,
    };
  }

  const dueInWindow = enabled.filter((schedule) => {
    if (schedule.trigger.type === 'cron') {
      return schedule.trigger.cron
        ? cronFired(schedule.trigger.cron, schedule.trigger.timezone, input.now, windowMs)
        : false;
    }
    if (schedule.trigger.type === 'interval') {
      const intervalMs = Number(schedule.trigger.intervalMs || 0);
      return intervalMs > 0 && intervalMs <= windowMs;
    }
    return false;
  }).length;
  const lastRunInWindow = enabled.filter((schedule) => {
    if (!schedule.lastRun) return false;
    const lastRunMs = Date.parse(schedule.lastRun);
    return Number.isFinite(lastRunMs) && input.now.getTime() - lastRunMs <= windowMs;
  }).length;
  const schedulesFiring =
    dueInWindow === 0 || lastRunInWindow > 0
      ? { ok: true, reason: null }
      : {
          ok: false,
          reason: `${dueInWindow} enabled schedule(s) were due within the last 24h but none recorded a lastRun in that window`,
        };

  return {
    enabled_schedule_count: enabled.length,
    scheduler_alive: schedulerAlive,
    schedules_firing: {
      ...schedulesFiring,
      due_in_window: dueInWindow,
      last_run_in_window: lastRunInWindow,
    },
    healthy: schedulerAlive.ok && schedulesFiring.ok,
  };
}

/**
 * LC-01b (pure): day-level dedup gate for scheduler ops alerts. The baseline
 * check runs hourly; without this gate a dead daemon would append 24 critical
 * alerts a day. Marker maps alert key -> last emitted UTC day (YYYY-MM-DD).
 */
export function shouldEmitDailyOpsAlert(
  marker: Record<string, string> | null,
  key: string,
  now: Date
): boolean {
  const today = now.toISOString().slice(0, 10);
  return marker?.[key] !== today;
}

let baselineConfigDegraded = false;

type CachedEnvelope<T> = {
  computed_at: string;
  ttl_ms: number;
  value: T;
};

type CachedSnapshot<T> = {
  value: T;
  cached: boolean;
  age_ms?: number;
};

export type BaselineMaintenanceState = {
  submitted: boolean;
  pending: boolean;
  reason: string | null;
};

function cachePath(name: string): string {
  return pathResolver.shared(`${BASELINE_CACHE_DIR}/${name}.json`);
}

function loadCachedSnapshot<T>(name: string): CachedSnapshot<T> | null {
  const path = cachePath(name);
  if (!safeExistsSync(path)) return null;
  try {
    const parsed = readJson<CachedEnvelope<T>>(path);
    const computedAt = new Date(parsed.computed_at).getTime();
    if (!Number.isFinite(computedAt)) return null;
    const ageMs = Date.now() - computedAt;
    if (ageMs > parsed.ttl_ms) return null;
    return {
      value: parsed.value,
      cached: true,
      age_ms: ageMs,
    };
  } catch {
    return null;
  }
}

function storeCachedSnapshot<T>(name: string, value: T, ttlMs: number): void {
  safeWriteFile(
    cachePath(name),
    JSON.stringify(
      {
        computed_at: nowIso(),
        ttl_ms: ttlMs,
        value,
      } satisfies CachedEnvelope<T>,
      null,
      2
    )
  );
}

function loadConnectionReadinessConfig(): {
  requiredServices: Record<string, ReadinessRule>;
  tenantGuard: { requireZeroDrift: boolean };
  configDegraded: boolean;
} {
  const configPath = pathResolver.rootResolve(
    'knowledge/product/governance/service-connection-readiness.json'
  );
  if (!safeExistsSync(configPath)) {
    baselineConfigDegraded = false;
    return {
      requiredServices: {},
      tenantGuard: { requireZeroDrift: true },
      configDegraded: false,
    };
  }
  const config = loadServiceConnectionReadinessConfig();
  if (!config) {
    baselineConfigDegraded = true;
    logger.warn(
      `[baseline-check] service-connection-readiness config parse failed, falling back to defaults: ${configPath}`
    );
    return {
      requiredServices: {},
      tenantGuard: { requireZeroDrift: true },
      configDegraded: true,
    };
  }
  baselineConfigDegraded = false;
  return {
    requiredServices: config.required_services || {},
    tenantGuard: {
      requireZeroDrift: config.tenant_guard?.require_zero_drift !== false,
    },
    configDegraded: false,
  };
}

export function parseConnectionReadinessConfig(
  raw: string,
  configPath = 'service-connection-readiness.json'
): {
  requiredServices: Record<string, ReadinessRule>;
  tenantGuard: { requireZeroDrift: boolean };
  configDegraded: boolean;
} {
  try {
    const parsed = parseSafeJsonInput(raw, 'baseline configuration') as {
      required_services?: Record<string, ReadinessRule>;
      tenant_guard?: { require_zero_drift?: unknown };
    };
    baselineConfigDegraded = false;
    return {
      requiredServices:
        parsed?.required_services && typeof parsed.required_services === 'object'
          ? parsed.required_services
          : {},
      tenantGuard: {
        requireZeroDrift: parsed?.tenant_guard?.require_zero_drift !== false,
      },
      configDegraded: false,
    };
  } catch (_) {
    baselineConfigDegraded = true;
    logger.warn(
      `[baseline-check] service-connection-readiness config parse failed, falling back to defaults: ${configPath}`
    );
    return {
      requiredServices: {},
      tenantGuard: { requireZeroDrift: true },
      configDegraded: true,
    };
  }
}

function profileRoot(): string {
  return resolveActiveProfileRoot();
}

function checkServiceConnectionReadiness(
  tenantDriftReport?: ReturnType<typeof scanTenantDrift>
): boolean {
  return withExecutionContext(
    'mission_controller',
    () => {
      const endpoints = loadServiceEndpointsCatalog();
      const services = endpoints?.services || {};

      const readinessConfig = loadConnectionReadinessConfig();
      if (readinessConfig.configDegraded) return false;
      const readinessRules = readinessConfig.requiredServices;
      if (Object.keys(readinessRules).length === 0) return false;

      for (const [serviceId, rule] of Object.entries(readinessRules)) {
        const service = services[serviceId];
        if (!service?.preset_path) return false;
        const presetPath = pathResolver.rootResolve(String(service.preset_path));
        if (!safeExistsSync(presetPath)) return false;

        const connection = secretGuard.loadConnectionDocument(serviceId);
        if (Object.keys(connection).length === 0) return false;

        const requiredAny = Array.isArray(rule?.required_keys_any) ? rule.required_keys_any : [];
        if (requiredAny.length > 0 && !hasRequiredServiceConnectionValue(connection, requiredAny)) {
          return false;
        }
      }

      if (readinessConfig.tenantGuard.requireZeroDrift) {
        const drift = tenantDriftReport ?? scanTenantDrift();
        if (drift.findings.length > 0) return false;
      }

      return true;
    },
    'ecosystem_architect'
  );
}

function getCachedTenantDrift() {
  const cached = loadCachedSnapshot<ReturnType<typeof scanTenantDrift>>('tenant-drift');
  if (cached) return cached;
  const value = scanTenantDrift();
  storeCachedSnapshot('tenant-drift', value, BASELINE_CACHE_TTL_MS);
  return { value, cached: false } satisfies CachedSnapshot<ReturnType<typeof scanTenantDrift>>;
}

function getCachedCoworkHealth() {
  const cached = loadCachedSnapshot<ReturnType<typeof runCoworkHealthCheck>>('cowork-health');
  if (cached) return cached;
  const value = runCoworkHealthCheck();
  storeCachedSnapshot('cowork-health', value, BASELINE_CACHE_TTL_MS);
  return { value, cached: false } satisfies CachedSnapshot<ReturnType<typeof runCoworkHealthCheck>>;
}

function readJanitorLastSubmissionMs(): number | null {
  return readJanitorLastSubmissionMarkerMs();
}

function markJanitorSubmission(): void {
  writeJanitorSubmissionMarker();
}

function maybeSubmitJanitorMaintenanceJob(): {
  submitted: boolean;
  pending: boolean;
  reason: string | null;
} {
  const lastCompletedMs = readJanitorLastRunMs();
  if (lastCompletedMs !== null && Date.now() - lastCompletedMs < JANITOR_MAINTENANCE_TTL_MS) {
    return { submitted: false, pending: false, reason: null };
  }

  const lastSubmittedMs = readJanitorLastSubmissionMs();
  if (lastSubmittedMs !== null && Date.now() - lastSubmittedMs < JANITOR_MAINTENANCE_TTL_MS) {
    return {
      submitted: false,
      pending: true,
      reason: 'storage janitor job is already pending',
    };
  }

  // Real run (not dry_run): the janitor only writes its completion marker on a
  // real run, so a dry-run submission can never satisfy readJanitorLastRunMs()
  // and would leave the baseline stuck at needs_attention for every TTL window.
  spawnManagedProcess({
    resourceId: `baseline-check:storage-janitor:${Date.now().toString(36)}`,
    kind: 'service',
    ownerId: 'baseline-check',
    ownerType: 'baseline-check-maintenance',
    command: process.execPath,
    args: [
      'dist/scripts/run_pipeline.js',
      '--input',
      'pipelines/storage-janitor.json',
      '--context',
      JSON.stringify({ dry_run: false }),
    ],
    spawnOptions: {
      cwd: pathResolver.rootDir(),
      env: process.env,
      detached: true,
      stdio: 'ignore',
    },
    shutdownPolicy: 'detached',
    metadata: {
      pipelineId: 'storage-janitor',
      dryRun: false,
      source: 'baseline-check',
    },
  });

  markJanitorSubmission();
  return {
    submitted: true,
    pending: true,
    reason: 'storage janitor job submitted',
  };
}

export function deriveBaselineStatus(
  result: { success: boolean; failedLayer?: string | null },
  janitorMaintenance: BaselineMaintenanceState,
  reasoningDegraded = false
): 'all_clear' | 'needs_onboarding' | 'needs_recovery' | 'needs_attention' {
  if (!result.success) {
    if (result.failedLayer === 'L3') return 'needs_onboarding';
    if (['L0', 'L1', 'L2'].includes(result.failedLayer || '')) return 'needs_recovery';
    return 'needs_attention';
  }
  if (janitorMaintenance.pending) return 'needs_attention';
  // LC-08: a healthy report while the reasoning chain silently degraded to
  // stub would invite real work on a fabricated brain — surface it.
  if (reasoningDegraded) return 'needs_attention';
  return 'all_clear';
}

// XP-05: failover chain switches (an earlier reasoning candidate failed, a
// later one served the call) are healthy behavior, not a degradation — so,
// unlike reasoning_degraded above, this never changes `status`. It is
// surfaced as a plain warning string so an operator sees "provider failover
// active" at session start instead of only discovering it via logs.
export function reasoningFailoverWarning(marker: ReasoningFailoverMarker | null): string | null {
  if (!marker) return null;
  return (
    `provider failover active: ${marker.from_mode} -> ${marker.to_mode}` +
    (marker.method ? ` (${marker.method})` : '') +
    `; last switch at ${marker.at}`
  );
}

// XP-01: the provider-capability-registry population job. Session start is
// the only place in the repo that reliably runs on a schedule (pipelines/
// baseline-check.json's hourly cron — see the cron-decision note near
// pipelines/baseline-check.json in docs), so baseline-check both consumes
// and refreshes the registry: `loadProviderCapabilityRegistry` returns the
// cached snapshot when it is fresh and probes-then-persists when it is
// stale/absent — mirroring `getCachedTenantDrift`/`getCachedCoworkHealth`
// above, except the TTL cache lives in the registry module itself rather
// than under `runtime/baseline-check-cache/`.
export const PROVIDER_CAPABILITY_PROBE_ENV = 'KYBERION_PROVIDER_CAPABILITY_PROBE';

export interface ProviderCapabilitiesSummary {
  probed_at: string | null;
  available: string[];
  excluded: { provider: string; reason: string }[];
}

/**
 * Pure projection from the full probe result to the compact shape surfaced
 * in the baseline report. A provider counts as "available" when its binary
 * was found and it is not known to be unauthenticated (`authenticated:
 * 'unknown'` — no cheap auth probe exists — still counts as available,
 * matching `filterChainByProviderCapability`'s routing semantics in
 * reasoning-bootstrap.ts). Everything else is excluded with a reason.
 */
export function summarizeProviderCapabilities(
  capabilities: ProviderCapability[]
): ProviderCapabilitiesSummary {
  if (capabilities.length === 0) {
    return { probed_at: null, available: [], excluded: [] };
  }
  const available: string[] = [];
  const excluded: { provider: string; reason: string }[] = [];
  for (const cap of capabilities) {
    if (cap.binary_found && cap.authenticated !== false) {
      available.push(cap.provider_id);
    } else {
      excluded.push({
        provider: cap.provider_id,
        reason: cap.probe_error || (!cap.binary_found ? 'binary not found' : 'not authenticated'),
      });
    }
  }
  return { probed_at: capabilities[0]!.probed_at, available, excluded };
}

export interface ProviderCapabilitiesSnapshot {
  summary: ProviderCapabilitiesSummary;
  cached: boolean;
  age_ms: number | null;
  probing_enabled: boolean;
}

const EMPTY_PROVIDER_CAPABILITIES_SUMMARY: ProviderCapabilitiesSummary = {
  probed_at: null,
  available: [],
  excluded: [],
};

/**
 * Dependency-injected core of the population job, kept separate from the
 * module-level `peekProviderCapabilityRegistry`/`loadProviderCapabilityRegistry`
 * imports so tests can exercise every branch (stale/absent/fresh/failing/
 * disabled) without ever reaching the real exec seam. Never throws — a
 * failure while reading or refreshing the registry degrades to an empty
 * summary rather than affecting `deriveBaselineStatus`, which does not
 * receive this value at all.
 */
export function resolveProviderCapabilitiesSnapshot(deps: {
  probingEnabled: boolean;
  peek: () => ProviderCapability[] | null;
  load: () => ProviderCapability[];
  now?: () => number;
}): ProviderCapabilitiesSnapshot {
  if (!deps.probingEnabled) {
    return {
      summary: EMPTY_PROVIDER_CAPABILITIES_SUMMARY,
      cached: false,
      age_ms: null,
      probing_enabled: false,
    };
  }

  try {
    const wasCached = deps.peek() !== null;
    const summary = summarizeProviderCapabilities(deps.load());
    const now = deps.now ?? (() => Date.now());
    const age_ms =
      summary.probed_at !== null ? now() - new Date(summary.probed_at).getTime() : null;
    return { summary, cached: wasCached, age_ms, probing_enabled: true };
  } catch (err) {
    logger.warn(
      `[baseline-check] provider capability probe failed (non-fatal, fail-open): ${err instanceof Error ? err.message : String(err)}`
    );
    return {
      summary: EMPTY_PROVIDER_CAPABILITIES_SUMMARY,
      cached: false,
      age_ms: null,
      probing_enabled: true,
    };
  }
}

function getProviderCapabilitiesSnapshot(): ProviderCapabilitiesSnapshot {
  return resolveProviderCapabilitiesSnapshot({
    probingEnabled: process.env[PROVIDER_CAPABILITY_PROBE_ENV] !== '0',
    peek: () => peekProviderCapabilityRegistry(),
    load: () => loadProviderCapabilityRegistry({ maxAgeMs: DEFAULT_PROVIDER_CAPABILITY_TTL_MS }),
  });
}

export async function runBaselineCheck() {
  killSwitch.startMonitor();

  // KM-01 fallback: without a resident chronos daemon the scheduled janitor
  // never fires, so session start submits a detached dry-run maintenance job
  // when the last completed run is stale. Failure-tolerant — maintenance must
  // never block the baseline check.
  let janitorMaintenance = { submitted: false, pending: false, reason: null as string | null };
  try {
    janitorMaintenance = maybeSubmitJanitorMaintenanceJob();
    if (janitorMaintenance.submitted) {
      logger.info(
        `[BASELINE] storage janitor maintenance job submitted: ${janitorMaintenance.reason || 'storage janitor job submitted'}`
      );
    } else if (janitorMaintenance.pending) {
      logger.info(
        `[BASELINE] storage janitor maintenance pending: ${janitorMaintenance.reason || 'storage janitor job is already pending'}`
      );
    }
  } catch (err: any) {
    logger.warn(`[BASELINE] storage janitor fallback failed: ${err?.message ?? String(err)}`);
  }
  const statePath = pathResolver.rootResolve('active/shared/runtime/state/pfc-state.json');
  const sentinel = new SovereignSentinel(statePath);
  const tenantDriftSnapshot = getCachedTenantDrift();
  const coworkHealthSnapshot = getCachedCoworkHealth();

  // XP-01 population job: failure-tolerant, like the janitor fallback above
  // — a broken probe must never block or influence the baseline status.
  let providerCapabilities: ProviderCapabilitiesSnapshot = {
    summary: EMPTY_PROVIDER_CAPABILITIES_SUMMARY,
    cached: false,
    age_ms: null,
    probing_enabled: process.env[PROVIDER_CAPABILITY_PROBE_ENV] !== '0',
  };
  try {
    providerCapabilities = getProviderCapabilitiesSnapshot();
  } catch (err: any) {
    logger.warn(
      `[BASELINE] provider capability probe failed (non-fatal): ${err?.message ?? String(err)}`
    );
  }

  // LC-01a: scheduler liveness snapshot (feeds L10 below). Evaluation failure
  // fails open with a warning — the read helpers themselves never throw, so
  // this catch is belt-and-braces only, but it must fail closed: a scheduler
  // state that cannot be evaluated is not evidence that the scheduler is
  // healthy.
  const schedulerNow = new Date();
  let schedulerHeartbeat: DaemonHeartbeatStatus = {
    daemon_id: CHRONOS_DAEMON_ID,
    status: 'missing',
    reason: 'not evaluated',
  };
  let schedulerHealth: SchedulerHealthReport = {
    enabled_schedule_count: 0,
    scheduler_alive: { ok: true, reason: 'not evaluated' },
    schedules_firing: {
      ok: true,
      reason: 'not evaluated',
      due_in_window: 0,
      last_run_in_window: 0,
    },
    healthy: true,
  };
  let failedSchedules: FailedScheduleFinding[] = [];
  try {
    const scheduleRegistry = loadScheduleRegistry();
    schedulerHeartbeat = readDaemonHeartbeat(CHRONOS_DAEMON_ID, {
      staleAfterMs: SCHEDULER_HEARTBEAT_MAX_AGE_MS,
      now: schedulerNow,
    });
    schedulerHealth = evaluateSchedulerHealth({
      schedules: scheduleRegistry.schedules,
      heartbeat: schedulerHeartbeat,
      now: schedulerNow,
    });
    failedSchedules = collectFailedSchedules(scheduleRegistry);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    schedulerHeartbeat = {
      daemon_id: CHRONOS_DAEMON_ID,
      status: 'malformed',
      reason: `scheduler health evaluation failed: ${reason}`,
    };
    schedulerHealth = schedulerHealthEvaluationFailure(reason);
    logger.warn(`[BASELINE] scheduler health evaluation failed (non-fatal): ${reason}`);
  }
  const auditLedger = readAuditLedgerFreshness(
    pathResolver.sharedLogsAudit(),
    schedulerNow.getTime()
  );
  // DR-04: observation permissions/costs are surfaced at session start. This
  // is observational and intentionally does not change baseline health: a
  // non-macOS host can still use the permission-free clipboard source while
  // reporting the unavailable accessibility/frame sources explicitly.
  const desktopObservationProbe = macosAutomationBridge.probe();
  const desktopObservation = {
    registry: listDesktopObservationSources(),
    readiness: assessDesktopObservationReadiness(desktopObservationProbe),
    bridge: desktopObservationProbe,
    data_tier_note: 'observation_tier is separate from personal/confidential/public data tier',
  };

  // LC-01b/LC-01c: escalate via ops alerts with day-level dedup (the baseline
  // runs hourly; one alert per class per UTC day). Hard-gated under vitest so
  // test imports of this module never touch the real observability log.
  const schedulerAlerts: {
    scheduler_alive: OpsAlertReceipt | null;
    failed_schedules: OpsAlertReceipt | null;
  } = { scheduler_alive: null, failed_schedules: null };
  if (!process.env.VITEST) {
    try {
      const marker = readSchedulerOpsAlertDays();
      if (
        !schedulerHealth.scheduler_alive.ok &&
        shouldEmitDailyOpsAlert(marker, 'scheduler_alive', schedulerNow)
      ) {
        schedulerAlerts.scheduler_alive = sendOpsAlert({
          severity: 'critical',
          category: 'scheduler',
          title: 'chronos scheduler daemon is not running — no schedules are firing',
          context: {
            reason: schedulerHealth.scheduler_alive.reason,
            heartbeat: schedulerHeartbeat,
            enabled_schedule_count: schedulerHealth.enabled_schedule_count,
          },
          recommendation:
            'Restart the scheduler (`pnpm chronos`) or install the LaunchAgent so it survives reboots (`pnpm kyberion chronos install`, then apply the printed launchctl steps).',
          options: [
            'pnpm chronos  # foreground restart',
            'pnpm kyberion chronos install  # print LaunchAgent install steps',
            'pnpm daemon:watchdog -- --json  # confirm recovery',
          ],
          dedupe_key: 'scheduler:chronos-daemon-dead',
        });
        enqueueOperationalLearningSignal({
          signalId: 'scheduler-daemon-dead',
          sourceType: 'routine_exception',
          sourceRef: `baseline:scheduler:${schedulerNow.toISOString().slice(0, 10)}`,
          title: 'Chronos scheduler availability requires operational review',
          summary:
            'Baseline detected a stale or malformed Chronos heartbeat. Review the LaunchAgent/runtime path and confirm schedules resume before promoting a permanent runbook change.',
          evidenceRefs: ['baseline-check:scheduler_alive'],
          metadata: { heartbeat: schedulerHeartbeat },
        });
        writeSchedulerOpsAlertDay('scheduler_alive', schedulerNow);
      }
      if (
        failedSchedules.length > 0 &&
        shouldEmitDailyOpsAlert(marker, 'failed_schedules', schedulerNow)
      ) {
        schedulerAlerts.failed_schedules = sweepFailedSchedules().alert;
        enqueueOperationalLearningSignal({
          signalId: 'scheduler-failed-schedules',
          sourceType: 'routine_exception',
          sourceRef: `baseline:failed-schedules:${schedulerNow.toISOString().slice(0, 10)}`,
          title: 'Scheduled pipelines require failure review',
          summary:
            'Baseline found scheduled pipelines with failed or accumulating failure state. Inspect root causes and decide whether a governed runbook or schedule policy change is needed.',
          evidenceRefs: failedSchedules.map((schedule) => `schedule:${schedule.id}`),
          metadata: { failed_schedules: failedSchedules },
        });
        writeSchedulerOpsAlertDay('failed_schedules', schedulerNow);
      }
    } catch (err: any) {
      logger.warn(
        `[BASELINE] scheduler ops-alert escalation failed (non-fatal): ${err?.message ?? String(err)}`
      );
    }
  }

  // LC-01a (iii): warn-level (never blocks): is any ops-alert delivery
  // channel configured? Without one, alerts land in the JSONL and nobody sees
  // them (553 undelivered records taught us this).
  const notificationPrefs = loadNotificationPreferences();
  const opsAlertRoute = resolveOperatorNotificationRoute('ops_alert', notificationPrefs);
  const opsAlertChannel = resolveOpsAlertChannelStatus({
    operatorRouteConfigured: Boolean(opsAlertRoute && opsAlertRoute !== 'mute'),
  });

  // L0: Physical Layer (CLI Tools)
  sentinel.registerLayer('L0', async () => {
    const res = await validateService({
      serviceName: 'Core Physical',
      cliBins: ['node', 'git', 'pnpm'],
    });
    return res.valid;
  });

  // L1: Neural Layer (SDK & Core Deps)
  sentinel.registerLayer('L1', async () => {
    const res = await validateService({
      serviceName: 'Core Neural',
      sdkModules: ['@agent/core'],
    });
    return res.valid;
  });

  // L2: Skeletal Layer (Directories & Build)
  sentinel.registerLayer('L2', async () => {
    const distPath = pathResolver.rootResolve('dist/scripts');
    return safeExistsSync(distPath);
  });

  // L3: Identity Layer (Soul)
  sentinel.registerLayer('L3', async () => {
    const identityPath = path.join(profileRoot(), 'my-identity.json');
    return safeExistsSync(identityPath);
  });

  // L4: Surface Layer (Background Daemons)
  sentinel.registerLayer('L4', async () => {
    const surfacesDir = pathResolver.rootResolve('knowledge/product/governance/surfaces');
    const surfacesSnapshot = pathResolver.rootResolve(
      'knowledge/product/governance/active-surfaces.json'
    );
    return safeExistsSync(surfacesDir) && safeExistsSync(surfacesSnapshot);
  });

  // L5: Trust/API Layer (Vault/Credentials)
  sentinel.registerLayer('L5', async () => {
    return checkServiceConnectionReadiness(tenantDriftSnapshot.value);
  });

  // L6: Cowork Integration Layer
  sentinel.registerLayer('L6', async () => {
    const coworkHealth = coworkHealthSnapshot.value;
    if (coworkHealth.warnings.length > 0) {
      coworkHealth.warnings.forEach((w) => process.stderr.write(`[COWORK WARN] ${w}\n`));
    }
    return coworkHealth.healthy;
  });

  // L7: Configuration Layer (OP-05) — warn-only for unknown/malformed
  // KYBERION_* vars (surfaced via envReport below, never blocking); only a
  // missing `required: true` registry entry fails this layer.
  const envReport = validateEnv();
  sentinel.registerLayer('L7', async () => envReport.errors.length === 0);

  // L8: Storage Hygiene Layer (AL-01) — janitor last-run freshness. Fails
  // (→ needs_attention via deriveBaselineStatus) when the janitor completion
  // marker is missing or older than 48h, i.e. TTL GC is not actually running.
  const janitorLastRunMs = readJanitorLastRunMs();
  sentinel.registerLayer('L8', async () => isJanitorMarkerFresh(janitorLastRunMs));

  // L9: NHI Lifecycle Layer (NI-05) — orphan identities. A non-retired agent
  // identity whose affiliation scope no longer exists is a missed offboarding
  // (OWASP NHI #1); it must degrade the baseline to needs_attention rather
  // than stay silently permanent. Read-only, never blocking L0-L2 recovery.
  const nhiOrphans = listOrphanNhiIdentities();
  sentinel.registerLayer('L9', async () => nhiOrphans.length === 0);

  // L10: Scheduler Layer (LC-01a) — chronos daemon liveness + schedules
  // actually firing. Fails (→ needs_attention via deriveBaselineStatus) when
  // enabled schedules exist but the daemon heartbeat is dead/stale or due
  // schedules recorded no lastRun in 24h. A fresh environment with zero
  // enabled schedules passes.
  sentinel.registerLayer('L10', async () => schedulerHealth.healthy);

  // EG-03: audit continuity is a first-class health layer.
  sentinel.registerLayer('L11', async () => auditLedger.fresh);

  const result = await sentinel.run();
  const state = sentinel.getState();

  // LC-08: bootstrap writes this marker when a non-stub mode kept stubs.
  const reasoningDegraded = readReasoningDegraded();
  // XP-05: the failover layer writes this marker when a later reasoning
  // candidate served a call the primary failed. Non-blocking — read-only,
  // never fed into deriveBaselineStatus.
  const reasoningFailover = readReasoningFailover();

  // Determine High-Level Status
  const status = deriveBaselineStatus(result, janitorMaintenance, reasoningDegraded !== null);

  // Format Output
  const report = {
    status,
    circuit_broken: result.circuitBroken,
    failed_layer: result.failedLayer || null,
    details: state.layers,
    config_degraded: baselineConfigDegraded,
    reasoning_degraded: reasoningDegraded,
    warnings: {
      reasoning_failover: reasoningFailoverWarning(reasoningFailover),
      // LC-01a (iii): warn-only, never a status input.
      ops_alert_channel_configured: opsAlertChannel.configured
        ? null
        : `no ops-alert delivery channel configured — alerts are recorded to active/shared/observability/ops-alerts.jsonl but never delivered; set ${opsAlertChannel.env_var}=<webhook url> or configure knowledge/personal/notification-preferences.json (then run \`pnpm ops:alerts -- --redeliver\`)`,
    },
    // LC-01: scheduler liveness observation surface (L10).
    scheduler: {
      ...schedulerHealth,
      heartbeat: {
        status: schedulerHeartbeat.status,
        age_ms: schedulerHeartbeat.age_ms ?? null,
        pid: schedulerHeartbeat.heartbeat?.pid ?? null,
        max_age_ms: SCHEDULER_HEARTBEAT_MAX_AGE_MS,
      },
      failed_schedules: failedSchedules,
      alerts: {
        scheduler_alive: schedulerAlerts.scheduler_alive?.id ?? null,
        failed_schedules: schedulerAlerts.failed_schedules?.id ?? null,
      },
    },
    audit_ledger: {
      ...auditLedger,
      freshness_max_age_ms: AUDIT_LEDGER_FRESHNESS_MAX_AGE_MS,
    },
    desktop_observation: desktopObservation,
    // XP-01: population job output — never consulted by deriveBaselineStatus,
    // purely observational (acceptance criterion 3: probe results surfaced
    // on the baseline-check observation surface).
    provider_capabilities: providerCapabilities.summary,
    cache: {
      tenant_drift: {
        cached: tenantDriftSnapshot.cached,
        age_ms: tenantDriftSnapshot.age_ms ?? null,
      },
      cowork_health: {
        cached: coworkHealthSnapshot.cached,
        age_ms: coworkHealthSnapshot.age_ms ?? null,
      },
      provider_capabilities: {
        cached: providerCapabilities.cached,
        age_ms: providerCapabilities.age_ms,
        probing_enabled: providerCapabilities.probing_enabled,
      },
    },
    maintenance: {
      janitor: {
        required: janitorMaintenance.pending || janitorMaintenance.submitted,
        submitted: janitorMaintenance.submitted,
        pending: janitorMaintenance.pending,
        reason: janitorMaintenance.reason,
        // AL-01 (L8): observed completion freshness of the janitor itself.
        last_completed_at:
          janitorLastRunMs !== null ? new Date(janitorLastRunMs).toISOString() : null,
        fresh: isJanitorMarkerFresh(janitorLastRunMs),
        freshness_max_age_ms: JANITOR_FRESHNESS_MAX_AGE_MS,
      },
    },
    env: {
      checked: envReport.checked,
      errors: envReport.errors,
      warnings: envReport.warnings,
      unknown: envReport.unknown,
      undocumented: envReport.undocumented,
    },
    // NI-05 (L9): orphan NHIs — an identity outliving its scope needs a
    // human retirement decision, so it is named here, not just counted.
    nhi: {
      orphans: nhiOrphans,
      orphan_count: nhiOrphans.length,
    },
  };
  return report;
}

// Keep the CLI entrypoint thin so the same governed check can be called by a
// typed actuator operation without spawning a script from an ADF step.
export const runBaselineCheckCli = defineScript({
  name: 'baseline-check',
  flags: [],
  async run(context) {
    try {
      const report = await runBaselineCheck();
      context.print(report);
      if (report.status === 'needs_recovery' && report.circuit_broken) {
        process.exitCode = 1;
      }
      return report;
    } catch (error) {
      const fatalReport = {
        status: 'fatal_error' as const,
        circuit_broken: true,
        failed_layer: null,
        details: {},
        error: error instanceof Error ? error.message : String(error),
      };
      context.print(fatalReport);
      process.exitCode = 1;
      return fatalReport;
    }
  },
});

if (
  isDirectScript(import.meta.url, 'run_baseline_check.ts') ||
  isDirectScript(import.meta.url, 'run_baseline_check.js')
)
  void runBaselineCheckCli();
