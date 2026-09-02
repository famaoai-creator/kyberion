import { appendJsonLine, readJson } from './foundation/json.js';
import { nowIso } from './foundation/time.js';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeUnlink,
  safeWriteFile,
} from './secure-io.js';
import { logger } from './core.js';

/**
 * XP-05 (CROSS_PROVIDER_EXECUTION_PLAN): "no silent provider degradation".
 * Same shape as LC-08's reasoning-degraded marker (reasoning-degradation.ts),
 * but for a different condition: the reasoning chain itself is healthy, a
 * *later* candidate in the failover chain served a call that an earlier
 * (primary) candidate failed to serve. This is additive and does not change
 * reasoning-degraded semantics — a session can be "failover active" without
 * being "degraded to stub", and vice versa.
 *
 * Two artifacts are written, both best-effort (a write failure here must
 * never fail the reasoning call that triggered it):
 *  - an append-only JSONL event log (`reasoning-failover-events.jsonl`) —
 *    every switch, for post-hoc audit;
 *  - a single "latest" marker (`reasoning-failover.json`), sibling to
 *    `reasoning-degraded.json`, that `run_baseline_check.ts` reads to warn
 *    an operator at session start that a provider failover is in effect.
 */

export interface ReasoningFailoverEvent {
  ts: string;
  from_mode: string;
  to_mode: string;
  provider_from?: string;
  provider_to?: string;
  method: string;
  error_summary: string;
}

export interface ReasoningFailoverMarker {
  from_mode: string;
  to_mode: string;
  provider_from?: string;
  provider_to?: string;
  method: string;
  at: string;
}

const EVENTS_RELATIVE_PATH = 'active/shared/runtime/reasoning-failover-events.jsonl';
const MARKER_RELATIVE_PATH = 'active/shared/runtime/state/reasoning-failover.json';
const ERROR_SUMMARY_MAX_CHARS = 200;

export function reasoningFailoverEventsPath(): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(EVENTS_RELATIVE_PATH), {
    allowMissingLeaf: true,
  });
}

export function reasoningFailoverMarkerPath(): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(MARKER_RELATIVE_PATH), {
    allowMissingLeaf: true,
  });
}

export function truncateErrorSummary(message: string): string {
  return message.length > ERROR_SUMMARY_MAX_CHARS
    ? `${message.slice(0, ERROR_SUMMARY_MAX_CHARS)}…`
    : message;
}

/** Append one switch event to the JSONL log. Best-effort: never throws. */
export function appendReasoningFailoverEvent(
  event: Omit<ReasoningFailoverEvent, 'ts' | 'error_summary'> & { error_summary: string }
): void {
  try {
    const eventsPath = reasoningFailoverEventsPath();
    safeMkdir(path.dirname(eventsPath), { recursive: true });
    const record: ReasoningFailoverEvent = {
      ts: nowIso(),
      ...event,
      error_summary: truncateErrorSummary(event.error_summary),
    };
    appendJsonLine(eventsPath, record);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`[reasoning-failover] failed to append failover event: ${detail}`);
  }
}

/** Overwrite the "latest failover" marker. Best-effort: never throws. */
export function markReasoningFailover(marker: Omit<ReasoningFailoverMarker, 'at'>): void {
  try {
    const markerPath = reasoningFailoverMarkerPath();
    safeMkdir(path.dirname(markerPath), { recursive: true });
    const full: ReasoningFailoverMarker = { ...marker, at: nowIso() };
    safeWriteFile(markerPath, `${JSON.stringify(full, null, 2)}\n`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`[reasoning-failover] failed to write failover marker: ${detail}`);
  }
}

export function clearReasoningFailover(): void {
  try {
    const markerPath = reasoningFailoverMarkerPath();
    if (safeExistsSync(markerPath)) safeUnlink(markerPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`[reasoning-failover] failed to clear failover marker: ${detail}`);
  }
}

export function readReasoningFailover(): ReasoningFailoverMarker | null {
  try {
    const markerPath = reasoningFailoverMarkerPath();
    if (!safeExistsSync(markerPath)) return null;
    const parsed = readJson<Partial<ReasoningFailoverMarker>>(markerPath);
    if (parsed && typeof parsed.from_mode === 'string' && typeof parsed.to_mode === 'string') {
      return parsed as ReasoningFailoverMarker;
    }
    return null;
  } catch {
    return null;
  }
}
