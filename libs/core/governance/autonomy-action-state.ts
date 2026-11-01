/**
 * autonomy-action-state — evidence-driven autonomy promotion/demotion for
 * POLICY ACTIONS (distinct from the per-dot ladder in dot-autonomy.ts).
 *
 * The gate's score thresholds are global — raising `auto_max_score` from 3 to
 * 7 would auto-enable eight unrelated actions at once. This module instead
 * adjusts autonomy per action, from observed evidence, in two bounded tiers:
 *
 *   tier1  approve → notify   (policy notify_min_decisions)
 *   tier2  notify  → auto     (policy auto_min_decisions)
 *
 * Evidence lives in an append-only ledger
 * (observability/autonomy-outcomes.jsonl): every gate consumer records the
 * decision it received plus, when it executed, whether the action succeeded.
 * Promotion state lives in runtime/autonomy-action-overrides.json — a runtime
 * file, because rewriting governed policy from a daemon would dirty the repo.
 * Malformed state is ignored wholesale (fail-safe to the base decision).
 *
 * Demotion is instant when the governed incident allowance is exceeded
 * (default zero), forcing 'approve' until the configured cooldown lapses.
 *
 * Retention (MSN-STORE-BOUNDS-2, P1/P2): every consumer needs only rows inside
 * the learning window — stats read a backward-scanned window, and an action
 * with no in-window rows is a no-op for the sweep (zero stats can neither
 * promote nor demote, and applyAutonomyOverride re-checks window stats before
 * relaxing). So the writer windows the ledger to the learning window plus a
 * margin ({@link autonomyOutcomesRetentionPolicy}); dropped rows go to the
 * compaction archive. Rotation would instead move the whole live window into
 * a segment no reader sees, erasing the evidence promotion depends on.
 */
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeWriteFile,
} from '../secure-io.js';
import { appendJsonLine, readJsonIfPresent } from '../foundation/json.js';
import { readJsonLinesSince, streamJsonLines } from '../jsonl-read.js';
import {
  appendOnlyStoreLockId,
  appendOnlyStoreMaintenanceDue,
  writeTimeArchiveDir,
  maintainStoreAfterAppend,
  type AppendOnlyStorePolicy,
  type MaintainStoreOutcome,
} from '../append-only-store.js';
import { createLogger } from '../logger.js';
import { storagePartitionSegments, PARTITIONED_RUNTIME_STATE_ROOTS } from '../storage-layout.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { loadAutonomyLearningPolicy } from './autonomy-learning-policy.js';
import { appendRetentionAudit } from '../storage-retention-expiry.js';
import type { AutonomousOpsDecision } from './autonomous-ops-gate.js';
import { withExecutionContext } from '../authority.js';
import { autonomyLearningCapability } from '../foundation/autonomy-learning-capability.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';

const logger = createLogger('autonomy-action-state');

export const AUTONOMY_OUTCOMES_PATH = 'active/shared/observability/autonomy-outcomes.jsonl';
export const AUTONOMY_OVERRIDES_PATH = 'active/shared/runtime/autonomy-action-overrides.json';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows are kept at least this long, even when the policy window is shorter. */
export const AUTONOMY_OUTCOMES_MIN_RETENTION_MS = 30 * DAY_MS;
/** Kept beyond the learning window so a widened window or clock skew still finds rows. */
export const AUTONOMY_OUTCOMES_RETENTION_MARGIN_MS = 7 * DAY_MS;
/** Ledger size that triggers write-time window retention. */
export const AUTONOMY_OUTCOMES_RETENTION_MIN_BYTES = 8 * 1024 * 1024;

interface AutonomyOutcomesStoreTuning {
  /** Retention threshold (tests inject small values). */
  minBytes?: number;
  /** Range-read chunk size (tests inject small values). */
  chunkBytes?: number;
  /** Archive directory (tests point it at a scratch dir). */
  archiveDir?: string;
}
let storeTuning: AutonomyOutcomesStoreTuning = {};

/** Test seam: override threshold / chunking / archive; call with `{}` to reset. */
export function setAutonomyOutcomesStoreTuningForTests(tuning: AutonomyOutcomesStoreTuning): void {
  storeTuning = { ...tuning };
}

function recordedAtMs(record: unknown): number | undefined {
  const raw = (record as Record<string, unknown> | null)?.recorded_at;
  if (typeof raw !== 'string') return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Explicit write-time policy for the outcomes ledger: keep the learning window
 * (at least 30d) plus a margin. Rows whose time cannot be read are kept (the
 * window never drops what it cannot date), so corruption stays visible.
 */
export function autonomyOutcomesRetentionPolicy(filePath: string): AppendOnlyStorePolicy {
  const windowMs =
    Math.max(loadAutonomyLearningPolicy().window_ms, AUTONOMY_OUTCOMES_MIN_RETENTION_MS) +
    AUTONOMY_OUTCOMES_RETENTION_MARGIN_MS;
  return {
    action: 'window',
    minBytes: storeTuning.minBytes ?? AUTONOMY_OUTCOMES_RETENTION_MIN_BYTES,
    windowMs,
    timeOf: recordedAtMs,
    archiveDir: storeTuning.archiveDir ?? writeTimeArchiveDir(filePath),
  };
}

/**
 * Write-time retention after an append, for the shared ledger and each tenant
 * partition alike. A tenant partition is maintained inside its own store
 * capability, which admits exactly this store's rewrite siblings
 * (`.compacting-*`, `.compact-out-*`, `.compact-restore-*`) and its sibling
 * `compaction-archive/` — so dropped rows are archived in the tenant's own
 * partition. The store lock and the retention audit live in shared runtime /
 * log floors the capability does not admit, so both stay under the caller's
 * identity, outside the store role (same rule as the customer decision case
 * lock). Never throws.
 */
function maintainOutcomesAfterAppend(
  p: string,
  deps: AutonomyStateDeps,
  now: Date
): MaintainStoreOutcome | undefined {
  const policy = autonomyOutcomesRetentionPolicy(p);
  const options = { now, chunkBytes: storeTuning.chunkBytes };
  if (!deps.tenantSlug) return maintainStoreAfterAppend(p, policy, options);
  try {
    if (!withTenantAutonomyStore(deps, () => appendOnlyStoreMaintenanceDue(p, policy)))
      return 'below-threshold';
    const audits: Array<Record<string, unknown>> = [];
    const outcome = withLockSync(
      appendOnlyStoreLockId(p),
      () =>
        withTenantAutonomyStore(deps, () =>
          maintainStoreAfterAppend(p, policy, {
            ...options,
            lockId: null,
            audit: (record) => audits.push(record),
          })
        ),
      2000
    );
    for (const record of audits) appendRetentionAudit(record);
    return outcome;
  } catch (err) {
    logger.warn(
      `[autonomy-action-state] tenant outcomes retention skipped for ${deps.tenantSlug} — ${err instanceof Error ? err.message : String(err)} | next: the append succeeded; a later append retries | evidence: ${pathResolver.toRepoRelative(p)}`
    );
    return 'failed';
  }
}

export interface AutonomyOutcomeRow {
  /** Stable caller execution identity; retries of one receipt count once. */
  receipt_id?: string;
  /** 'execution' rows carry results only — they never count as decisions. */
  kind?: 'decision' | 'execution';
  action_id: string;
  /** What the gate decided for this invocation. */
  decision: AutonomousOpsDecision;
  /** Whether the caller actually executed the action. */
  executed: boolean;
  /** Execution result — true only when the action demonstrably succeeded. */
  ok?: boolean;
  error?: string;
  recorded_at: string;
}

interface ActionOverride {
  /** 'auto' | 'notify': relax the base decision toward this level. */
  relaxed_to?: AutonomousOpsDecision;
  promoted_at?: string;
  demoted_until?: string;
  demote_reason?: string;
  stats?: { decisions: number; succeeded: number; incidents: number };
}

interface ActionOverridesFile {
  version: 1;
  overrides: Record<string, ActionOverride>;
}

export interface AutonomyStateDeps {
  rootDir?: string;
  now?: () => Date;
  tenantSlug?: string;
}

/** Only this store's typed operations receive the bounded tenant writer role.
 * Alternate fixture roots retain the original caller's permissions. */
function withTenantAutonomyStore<T>(deps: AutonomyStateDeps, operation: () => T): T {
  if (!deps.tenantSlug || (deps.rootDir && path.resolve(deps.rootDir) !== pathResolver.rootDir()))
    return operation();
  const directory = pathResolver.toRepoRelative(
    path.dirname(filePath(deps, AUTONOMY_OUTCOMES_PATH))
  );
  return runInResourceAccessScope(autonomyLearningCapability(deps.tenantSlug, directory), () =>
    withExecutionContext('autonomy_learning_store', operation, undefined, deps.tenantSlug)
  );
}

function filePath(deps: AutonomyStateDeps, rel: string): string {
  // Resolve the protected runtime partition through canonical storage rules.
  // Never read legacy system evidence
  // as tenant evidence, even when no tenant-specific file exists yet.
  const scoped = deps.tenantSlug
    ? path.posix.join(
        PARTITIONED_RUNTIME_STATE_ROOTS.autonomy_learning,
        ...storagePartitionSegments({
          kind: 'tier',
          tier: 'confidential',
          tenant: deps.tenantSlug,
        }),
        path.basename(rel)
      )
    : rel;
  return assertSafeRepositoryPath(
    deps.rootDir && path.resolve(deps.rootDir) !== pathResolver.rootDir()
      ? path.join(deps.rootDir, scoped)
      : pathResolver.rootResolve(scoped),
    {
      allowMissingLeaf: true,
    }
  );
}

/** Append a gate decision (and optional execution result) to the ledger. */
export function recordAutonomyOutcome(
  row: Omit<AutonomyOutcomeRow, 'recorded_at'>,
  deps: AutonomyStateDeps = {}
): void {
  const p = filePath(deps, AUTONOMY_OUTCOMES_PATH);
  const now = deps.now?.() ?? new Date();
  withTenantAutonomyStore(deps, () => {
    safeMkdir(path.dirname(p), { recursive: true });
    appendJsonLine(
      p,
      {
        ...row,
        receipt_id: row.receipt_id ?? randomUUID(),
        recorded_at: now.toISOString(),
      },
      { leadingNewline: true }
    );
  });
  maintainOutcomesAfterAppend(p, deps, now);
}

/** Record an execution result without double-counting the decision row
 *  the gate already wrote for the same evaluation. */
export function recordAutonomyExecution(
  row: { action_id: string; receipt_id: string; ok: boolean; error?: string },
  deps: AutonomyStateDeps = {}
): void {
  const p = filePath(deps, AUTONOMY_OUTCOMES_PATH);
  const now = deps.now?.() ?? new Date();
  withTenantAutonomyStore(deps, () => {
    safeMkdir(path.dirname(p), { recursive: true });
    appendJsonLine(
      p,
      {
        kind: 'execution',
        receipt_id: row.receipt_id,
        action_id: row.action_id,
        executed: true,
        ok: row.ok,
        ...(row.error ? { error: row.error } : {}),
        recorded_at: now.toISOString(),
      },
      { leadingNewline: true }
    );
  });
  maintainOutcomesAfterAppend(p, deps, now);
}

/** Distinct action ids present in the ledger — sweeps must cover every
 *  recorded action, not a hardcoded subset, or most promotions never fire.
 *  The live ledger holds the window + margin, which covers every action a
 *  sweep can change (an action with no in-window rows is a sweep no-op). */
export function listAutonomyActionIds(deps: AutonomyStateDeps = {}): string[] {
  const p = filePath(deps, AUTONOMY_OUTCOMES_PATH);
  if (!withTenantAutonomyStore(deps, () => safeExistsSync(p))) return [];
  // Consume the stream inside the store scope: the generator reads lazily.
  return withTenantAutonomyStore(deps, () => {
    const ids = new Set<string>();
    for (const row of streamJsonLines<Partial<AutonomyOutcomeRow>>(p, {
      onMalformed: 'skip',
      chunkBytes: storeTuning.chunkBytes,
    })) {
      if (typeof row?.action_id === 'string' && row.action_id) ids.add(row.action_id);
    }
    return [...ids];
  });
}

export interface AutonomyActionStats {
  decisions: number;
  /** Executed runs that returned ok=true. */
  succeeded: number;
  /** Executed runs that failed (ok=false) or produced an error. */
  incidents: number;
  /** executed && ok over all executed runs. */
  outcome_success: number;
}

export function actionAutonomyStats(
  actionId: string,
  deps: AutonomyStateDeps = {}
): AutonomyActionStats {
  const now = (deps.now?.() ?? new Date()).getTime();
  const cutoff = now - loadAutonomyLearningPolicy().window_ms;
  const p = filePath(deps, AUTONOMY_OUTCOMES_PATH);
  const stats: AutonomyActionStats = {
    decisions: 0,
    succeeded: 0,
    incidents: 0,
    outcome_success: 0,
  };
  if (!withTenantAutonomyStore(deps, () => safeExistsSync(p))) return stats;
  const successfulReceipts = new Set<string>();
  // Corruption must not erase a possible failure and leave only successful
  // evidence. Exceed even the largest validated incident allowance. The
  // backward scan stops at the first row older than the window (rows are
  // append-ordered by time); undatable rows never stop it and are flagged
  // below, so corruption inside the window still fails closed.
  for (const row of withTenantAutonomyStore(deps, () =>
    readJsonLinesSince<Partial<AutonomyOutcomeRow>>(p, {
      sinceMs: cutoff,
      timeOf: recordedAtMs,
      chunkBytes: storeTuning.chunkBytes,
      onMalformed: () => {
        stats.incidents = Number.MAX_SAFE_INTEGER;
      },
    })
  )) {
    if (!row || typeof row !== 'object' || typeof row.action_id !== 'string' || !row.action_id) {
      stats.incidents = Number.MAX_SAFE_INTEGER;
      continue;
    }
    if (row?.action_id !== actionId) continue;
    const ts = Date.parse(String(row.recorded_at ?? ''));
    if (
      !Number.isFinite(ts) ||
      ts > now ||
      typeof row.executed !== 'boolean' ||
      (row.kind !== undefined && !['decision', 'execution'].includes(row.kind))
    ) {
      stats.incidents = Number.MAX_SAFE_INTEGER;
      continue;
    }
    if (ts < cutoff) continue;
    // Legacy rows without a receipt id remain readable as decisions, but
    // cannot establish execution authority. Failures always remain visible.
    const success = row.ok === true && !row.error;
    const freshSuccess =
      success &&
      typeof row.receipt_id === 'string' &&
      row.receipt_id.length > 0 &&
      !successfulReceipts.has(row.receipt_id);
    if (row.kind === 'execution') {
      if (row.executed !== true) continue;
      if (freshSuccess) {
        stats.succeeded++;
        successfulReceipts.add(row.receipt_id!);
      } else if (!success) stats.incidents++;
      continue;
    }
    if (row.kind !== undefined && row.kind !== 'decision') continue;
    if (!['auto', 'approve', 'notify'].includes(String(row.decision))) {
      stats.incidents = Number.MAX_SAFE_INTEGER;
      continue;
    }
    stats.decisions++;
    if (row.executed === true) {
      if (freshSuccess) {
        stats.succeeded++;
        successfulReceipts.add(row.receipt_id!);
      } else if (!success) stats.incidents++;
    }
  }
  const executed = stats.succeeded + stats.incidents;
  stats.outcome_success = executed > 0 ? stats.succeeded / executed : 0;
  return stats;
}

function loadOverrides(deps: AutonomyStateDeps): ActionOverridesFile {
  const p = filePath(deps, AUTONOMY_OVERRIDES_PATH);
  let parsed: ActionOverridesFile | null;
  try {
    parsed = withTenantAutonomyStore(deps, () => readJsonIfPresent<ActionOverridesFile>(p));
  } catch {
    return { version: 1, overrides: {} };
  }
  if (
    parsed?.version !== 1 ||
    typeof parsed.overrides !== 'object' ||
    parsed.overrides === null ||
    Array.isArray(parsed.overrides)
  ) {
    return { version: 1, overrides: {} };
  }
  for (const value of Object.values(parsed.overrides)) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value.relaxed_to !== undefined && !['auto', 'notify'].includes(value.relaxed_to)) ||
      (value.demoted_until !== undefined && !Number.isFinite(Date.parse(value.demoted_until)))
    ) {
      return { version: 1, overrides: {} };
    }
  }
  return parsed;
}

function saveOverrides(state: ActionOverridesFile, deps: AutonomyStateDeps): void {
  const p = filePath(deps, AUTONOMY_OVERRIDES_PATH);
  withTenantAutonomyStore(deps, () => {
    safeMkdir(path.dirname(p), { recursive: true });
    safeWriteFile(p, JSON.stringify(state, null, 2) + '\n');
  });
}

/**
 * Apply runtime promotion/demotion to a gate decision. Demotion forces the
 * base decision (never relaxes); promotion lifts at most to `relaxed_to`
 * and never past 'auto'. Escalations (never_auto, high_risk, budget) are
 * applied by the caller before this — overrides cannot undo them.
 */
export function applyAutonomyOverride(
  actionId: string,
  decision: AutonomousOpsDecision,
  escalations: readonly string[],
  deps: AutonomyStateDeps = {}
): { decision: AutonomousOpsDecision; applied?: string } {
  const policy = loadAutonomyLearningPolicy();
  if (!policy.enabled) return { decision };
  const { overrides } = loadOverrides(deps);
  const o = Object.hasOwn(overrides, actionId) ? overrides[actionId] : undefined;
  if (!o) return { decision };
  const now = deps.now?.() ?? new Date();
  if (o.demoted_until && Date.parse(o.demoted_until) > now.getTime()) {
    return { decision: 'approve', applied: 'demoted' };
  }
  const rank: Record<AutonomousOpsDecision, number> = { approve: 0, notify: 1, auto: 2 };
  if (o.relaxed_to && escalations.length === 0 && rank[decision] < rank[o.relaxed_to]) {
    const stats = actionAutonomyStats(actionId, deps);
    const minimum =
      o.relaxed_to === 'auto' ? policy.auto_min_decisions : policy.notify_min_decisions;
    if (
      stats.decisions < minimum ||
      stats.succeeded < minimum ||
      stats.incidents > policy.max_incidents ||
      stats.outcome_success < policy.min_outcome_success
    ) {
      return { decision };
    }
    return { decision: o.relaxed_to, applied: `relaxed_to:${o.relaxed_to}` };
  }
  return { decision };
}

export interface AutonomySweepResult {
  promoted: string[];
  demoted: string[];
  held: string[];
}

/** Stable per-file lock id for an overrides file (fixed length, like ledger.ts). */
export function autonomyOverridesLockId(overridesPath: string): string {
  return `autonomy-learning-${createHash('sha256').update(path.resolve(overridesPath)).digest('hex')}`;
}

/**
 * Recompute per-action overrides from the ledger. Called periodically (the
 * daemon watchdog sweeps at end of run). Promotion and demotion are
 * asymmetric by design: promotion needs sustained clean evidence; demotion
 * fires on a single fresh incident.
 */
export function sweepAutonomyActionStates(
  actionIds: readonly string[],
  deps: AutonomyStateDeps = {}
): AutonomySweepResult {
  const policy = loadAutonomyLearningPolicy();
  if (!policy.enabled) return { promoted: [], demoted: [], held: [...actionIds] };
  // Serialize read/modify/write sweeps per physical partition. A concurrent
  // sweep must not overwrite a demotion observed by another writer.
  // The lock id hashes the absolute path: lock-utils URL-encodes the id into one
  // file name, which a raw path overflows (ENAMETOOLONG) under a long root.
  return withLockSync(autonomyOverridesLockId(filePath(deps, AUTONOMY_OVERRIDES_PATH)), () => {
    const state = loadOverrides(deps);
    const now = deps.now?.() ?? new Date();
    const result: AutonomySweepResult = { promoted: [], demoted: [], held: [] };

    for (const actionId of actionIds) {
      const stats = actionAutonomyStats(actionId, deps);
      const existing = Object.hasOwn(state.overrides, actionId) ? state.overrides[actionId]! : {};
      const demotedUntil = existing.demoted_until ? Date.parse(existing.demoted_until) : 0;

      if (demotedUntil > now.getTime()) {
        result.held.push(actionId);
        continue;
      }

      // Exceeding the governed incident allowance wins over promotion.
      if (
        stats.incidents > policy.max_incidents &&
        (!existing.demoted_until || demotedUntil < now.getTime())
      ) {
        state.overrides[actionId] = {
          demoted_until: new Date(now.getTime() + policy.cooldown_ms).toISOString(),
          demote_reason: `${stats.incidents} incident(s) in window`,
          stats: {
            decisions: stats.decisions,
            succeeded: stats.succeeded,
            incidents: stats.incidents,
          },
        };
        result.demoted.push(actionId);
        continue;
      }

      // Tier-2 needs successful execution receipts, never only gate attempts.
      const executedRuns = stats.succeeded + stats.incidents;
      const executionProven =
        stats.decisions >= policy.auto_min_decisions &&
        stats.succeeded >= policy.auto_min_decisions &&
        executedRuns > 0 &&
        stats.outcome_success >= policy.min_outcome_success &&
        stats.incidents <= policy.max_incidents;
      if (executionProven) {
        if (existing.relaxed_to !== 'auto') {
          state.overrides[actionId] = {
            ...existing,
            relaxed_to: 'auto',
            promoted_at: now.toISOString(),
            stats: {
              decisions: stats.decisions,
              succeeded: stats.succeeded,
              incidents: stats.incidents,
            },
          };
          result.promoted.push(`${actionId}→auto`);
          continue;
        }
      }

      // Tier-1: approve→notify is cheaper — sustained volume, zero incidents.
      if (
        !existing.relaxed_to &&
        stats.decisions >= policy.notify_min_decisions &&
        stats.succeeded >= policy.notify_min_decisions &&
        stats.outcome_success >= policy.min_outcome_success &&
        stats.incidents <= policy.max_incidents
      ) {
        state.overrides[actionId] = {
          relaxed_to: 'notify',
          promoted_at: now.toISOString(),
          stats: {
            decisions: stats.decisions,
            succeeded: stats.succeeded,
            incidents: stats.incidents,
          },
        };
        result.promoted.push(`${actionId}→notify`);
        continue;
      }
      result.held.push(actionId);
    }

    if (result.promoted.length || result.demoted.length) {
      saveOverrides(state, deps);
      logger.info(
        `[AUTONOMY] sweep: promoted=[${result.promoted.join(',')}] demoted=[${result.demoted.join(',')}]`
      );
    }
    return result;
  });
}
