/**
 * Dot wake ledger (`dot-wake-ledger.jsonl`) — row shape, the per-process
 * incremental read, size-gated compaction and the outcome writer. See the
 * dot-runtime module note for the due-ness semantics per outcome; dot-runtime
 * re-exports every public name. Imports dot-runtime for types only.
 */
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir } from '../secure-io.js';
import { appendJsonLine } from '../foundation/json.js';
import { runtimeStatePath } from '../foundation/runtime-state-roots.js';
import { readJsonLinesCachedAcrossCompaction } from '../storage/jsonl-parked-read.js';
import { createLogger } from '../logger.js';
import {
  compactDotWakeLedgerAt,
  type DotWakeLedgerCompactionResult,
} from './dot-wake-ledger-compaction.js';
import type { DotCharter, DotTrigger } from './dot-charter.js';
import type { DotFollowupInput } from './dot-followups.js';
import { dotStatePath } from './dot-state-paths.js';
import {
  classifyDotWakeReason,
  isDotWakeProcessFailure,
  DOT_WAKE_FAILURE_CATEGORY,
  type DotWakeReasonCode,
} from './dot-wake-reasons.js';
import type { DotRuntimeDeps, DueDotTrigger } from './dot-runtime.js';

const logger = createLogger('dot-runtime');

export const DOT_WAKE_LEDGER_PATH = runtimeStatePath('dot.wakeLedger').logicalPath;

export type DotWakeOutcome = 'delivered' | 'skipped' | 'failed' | 'rejected';

/** Runtime-only trigger kinds beyond the charter's declared ones. */
export type DotWakeTrigger = DotTrigger | { kind: 'followup' } | { kind: 'outcome' };

export interface DotWakeLedgerEntry {
  scope?: DotCharter['scope'];
  /** Durable event attempt correlation; absence never proves a dispatch did not occur. */
  event_attempt_id?: string;
  dot_id: string;
  trigger_key: string;
  kind: DotWakeTrigger['kind'] | 'manual';
  fired_at: string;
  outcome: DotWakeOutcome;
  reason?: string;
  /** Classified cause of a failed wake; `reason` keeps the original text. */
  reason_code?: DotWakeReasonCode;
  turns_run?: number;
  tokens_used?: number;
  /** The dot's own words (proposal block removed), so "why did it propose nothing?" is answerable. */
  summary?: string;
  /**
   * Delivered, but the trigger stays pending: the follow-up this wake was
   * completing could not persist its successor, so the parent follow-up is
   * retried (with failure backoff) instead of silently ending the chain.
   */
  trigger_retained?: boolean;
  /** Exact schedule to recover without replaying the model or governed proposals. */
  followup_retry?: { scheduled_at: string; values: DotFollowupInput[] };
  /**
   * A cron wake closed without calling the model because nothing changed since
   * the last real wake ({@link dotCronWakeIdleReason}). Recorded as `delivered`
   * so the cron key and catch-up bookkeeping treat it as handled.
   */
  idle_skip?: true;
}

/** Repo-root-relative runtime path for a dot store (honours `deps.rootDir`). */
export function dotRuntimePath(rootDir: string | undefined, rel: string): string {
  return path.join(rootDir ?? pathResolver.rootDir(), rel);
}

/**
 * The wake ledger is load-bearing history (a delivered/rejected key stays
 * consumed forever), so it is never truncated; instead every hot-path read —
 * due-ness, the circuit, and the per-skip dedupe in
 * {@link recordDotWakeOutcome} — goes through a per-process incremental
 * replay that parses only the rows appended since the previous call (G01).
 */
export function readDotWakeLedger(deps: DotRuntimeDeps = {}): DotWakeLedgerEntry[] {
  // Parked-aware: a compaction in another process never hides consumed keys.
  return readJsonLinesCachedAcrossCompaction<DotWakeLedgerEntry>(
    dotRuntimePath(deps.rootDir, DOT_WAKE_LEDGER_PATH)
  )
    .filter((row) => typeof row?.dot_id === 'string' && typeof row?.trigger_key === 'string')
    .map((row) => {
      if (row.scope?.tier === 'public' && !row.scope.tenant_slug) return row;
      // Old unscoped rows never become public just because their producer omitted tier.
      return {
        ...row,
        summary: undefined,
        followup_retry: undefined,
        ...(row.reason
          ? {
              reason: isDotWakeProcessFailure(row.reason)
                ? DOT_WAKE_FAILURE_CATEGORY.backend
                : row.reason_code === 'charter' || row.reason === DOT_WAKE_FAILURE_CATEGORY.charter
                  ? DOT_WAKE_FAILURE_CATEGORY.charter
                  : row.outcome === 'failed'
                    ? DOT_WAKE_FAILURE_CATEGORY.wake
                    : `scoped wake ${row.outcome}`,
            }
          : {}),
      };
    });
}

/** Replay-safe, size-gated compaction of the wake ledger (see dot-wake-ledger-compaction.ts). */
export function compactDotWakeLedger(
  deps: DotRuntimeDeps & {
    compactMinBytes?: number;
    chunkBytes?: number;
    maxLineBytes?: number;
  } = {}
): DotWakeLedgerCompactionResult {
  return compactDotWakeLedgerAt(dotRuntimePath(deps.rootDir, DOT_WAKE_LEDGER_PATH), {
    compactMinBytes: deps.compactMinBytes,
    chunkBytes: deps.chunkBytes,
    maxLineBytes: deps.maxLineBytes,
    now: deps.now?.(),
  });
}

export function appendJsonlEnsured(rel: string, value: unknown, deps: DotRuntimeDeps): void {
  const filePath = dotRuntimePath(deps.rootDir, rel);
  safeMkdir(path.dirname(filePath), { recursive: true });
  appendJsonLine(filePath, value);
}

/**
 * Append a wake-ledger row. 'skipped' rows are written at most once per
 * trigger key — they are an audit marker, not a consumption record.
 */
export function recordDotWakeOutcome(
  charter: DotCharter,
  trigger: DueDotTrigger | undefined,
  outcome: DotWakeOutcome,
  deps: DotRuntimeDeps & {
    reason?: string;
    reason_code?: DotWakeReasonCode;
    turns_run?: number;
    tokens_used?: number;
    summary?: string;
    trigger_retained?: boolean;
    followup_retry?: DotWakeLedgerEntry['followup_retry'];
    idle_skip?: boolean;
  } = {}
): void {
  const now = deps.now?.() ?? new Date();
  const key = trigger?.key ?? `manual:${now.toISOString()}`;
  if (outcome === 'skipped') {
    const already = readDotWakeLedger(deps).some(
      (row) => row.dot_id === charter.dot_id && row.trigger_key === key && row.outcome === 'skipped'
    );
    if (already) return;
  }
  // The writer maintains its own store: wakes are rare, so an opportunistic
  // size-gated compaction here keeps the ledger bounded without a hot-path
  // read — a compaction failure must never block outcome recording.
  try {
    compactDotWakeLedger(deps);
  } catch (error) {
    logger.warn(
      `[DOT] wake-ledger compaction failed — ledger stays append-only | next: inspect the archive/staging siblings | evidence: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const row: DotWakeLedgerEntry = {
    scope: charter.scope,
    dot_id: charter.dot_id,
    ...(deps.eventAttemptId ? { event_attempt_id: deps.eventAttemptId } : {}),
    trigger_key: key,
    kind: trigger?.trigger.kind ?? 'manual',
    fired_at: now.toISOString(),
    outcome,
    ...(deps.reason ? { reason: deps.reason } : {}),
    ...(outcome === 'failed'
      ? { reason_code: deps.reason_code ?? classifyDotWakeReason(deps.reason) }
      : deps.reason_code
        ? { reason_code: deps.reason_code }
        : {}),
    ...(deps.turns_run !== undefined ? { turns_run: deps.turns_run } : {}),
    ...(deps.tokens_used !== undefined ? { tokens_used: deps.tokens_used } : {}),
    ...(deps.summary ? { summary: deps.summary } : {}),
    ...(deps.trigger_retained && outcome === 'delivered' ? { trigger_retained: true } : {}),
    ...(deps.followup_retry ? { followup_retry: deps.followup_retry } : {}),
    ...(deps.idle_skip && outcome === 'delivered' ? { idle_skip: true as const } : {}),
  };
  const scoped = charter.scope.tier !== 'public' || Boolean(charter.scope.tenant_slug);
  if (scoped) appendJsonlEnsured(dotStatePath(charter, 'wake-ledger.jsonl'), row, deps);
  appendJsonlEnsured(
    DOT_WAKE_LEDGER_PATH,
    scoped
      ? {
          ...row,
          summary: undefined,
          followup_retry: undefined,
          ...(row.reason
            ? {
                reason: isDotWakeProcessFailure(row.reason)
                  ? DOT_WAKE_FAILURE_CATEGORY.backend
                  : row.reason_code === 'charter' ||
                      row.reason === DOT_WAKE_FAILURE_CATEGORY.charter
                    ? DOT_WAKE_FAILURE_CATEGORY.charter
                    : row.outcome === 'failed'
                      ? DOT_WAKE_FAILURE_CATEGORY.wake
                      : `scoped wake ${row.outcome}`,
              }
            : {}),
        }
      : row,
    deps
  );
}
