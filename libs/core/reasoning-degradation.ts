import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { readJson } from './foundation/json.js';
import { parseSafeJsonObjectValue } from './foundation/safe-json.js';
import { nowIso } from './foundation/time.js';
import { parseIso } from './foundation/time.js';
import { safeExistsSync, safeMkdir, safeUnlink, safeWriteFile } from './secure-io.js';
import { logger } from './core.js';

/**
 * LC-08 (LOOP_CLOSURE_PLAN): fail-loud marker for the "selected reasoning mode
 * could not build a backend, stubs kept" degradation. Bootstrap writes the
 * marker; baseline-check reads it and downgrades an otherwise-healthy report
 * to needs_attention so the operator learns about the stub brain at session
 * start instead of after a mission "succeeds" on fabricated output.
 */

export interface ReasoningDegradedMarker {
  mode: string;
  reason: string;
  at: string;
}

const MARKER_RELATIVE_PATH = 'active/shared/runtime/state/reasoning-degraded.json';

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const expectedKeys = new Set(expected);
  const unknown = Object.keys(record).filter((key) => !expectedKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown field(s): ${unknown.join(', ')}`);
  }
}

function parseRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  const timestamp = parseRequiredString(value, label);
  try {
    parseIso(timestamp);
  } catch {
    throw new Error(`${label} must be a valid ISO timestamp`);
  }
  return timestamp;
}

export function parseReasoningDegradedMarker(value: unknown): ReasoningDegradedMarker {
  const record = parseSafeJsonObjectValue(value, 'reasoning degraded marker');
  assertExactKeys(record, ['mode', 'reason', 'at'], 'reasoning degraded marker');
  return {
    mode: parseRequiredString(record.mode, 'reasoning degraded marker.mode'),
    reason: parseRequiredString(record.reason, 'reasoning degraded marker.reason'),
    at: parseTimestamp(record.at, 'reasoning degraded marker.at'),
  };
}

export function reasoningDegradedMarkerPath(): string {
  return pathResolver.rootResolve(MARKER_RELATIVE_PATH);
}

export function markReasoningDegraded(mode: string, reason: string): void {
  try {
    const markerPath = reasoningDegradedMarkerPath();
    safeMkdir(path.dirname(markerPath), { recursive: true });
    const marker = parseReasoningDegradedMarker({ mode, reason, at: nowIso() });
    safeWriteFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`[reasoning-degradation] failed to write degraded marker: ${detail}`);
  }
}

export function clearReasoningDegraded(): void {
  try {
    const markerPath = reasoningDegradedMarkerPath();
    if (safeExistsSync(markerPath)) safeUnlink(markerPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`[reasoning-degradation] failed to clear degraded marker: ${detail}`);
  }
}

export function readReasoningDegraded(): ReasoningDegradedMarker | null {
  try {
    const markerPath = reasoningDegradedMarkerPath();
    if (!safeExistsSync(markerPath)) return null;
    return parseReasoningDegradedMarker(readJson<unknown>(markerPath));
  } catch {
    return null;
  }
}
