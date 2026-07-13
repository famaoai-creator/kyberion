import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeUnlink, safeWriteFile } from './secure-io.js';
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

export function reasoningDegradedMarkerPath(): string {
  return pathResolver.rootResolve(MARKER_RELATIVE_PATH);
}

export function markReasoningDegraded(mode: string, reason: string): void {
  try {
    const markerPath = reasoningDegradedMarkerPath();
    safeMkdir(path.dirname(markerPath), { recursive: true });
    const marker: ReasoningDegradedMarker = { mode, reason, at: new Date().toISOString() };
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
    const parsed = JSON.parse(safeReadFile(markerPath, { encoding: 'utf8' }) as string);
    if (parsed && typeof parsed.mode === 'string' && typeof parsed.reason === 'string') {
      return parsed as ReasoningDegradedMarker;
    }
    return null;
  } catch {
    return null;
  }
}
