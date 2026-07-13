import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { logger } from './core.js';

/**
 * LC-02 follow-up: success-first, promote-on-reuse needs a reuse signal.
 * Every successful ad-hoc (non-catalog) pipeline run is tallied here; paths
 * that keep succeeding are promotion candidates surfaced by run_pipeline and
 * the operator packet. Deterministic — no similarity guessing, exact path.
 */

export interface AdhocRunTally {
  path: string;
  count: number;
  last_at: string;
}

const LEDGER_RELATIVE_PATH = 'active/shared/runtime/feedback-loop/adhoc-pipeline-runs.json';
const MAX_ENTRIES = 200;
export const PROMOTION_CANDIDATE_MIN_RUNS = 3;

function ledgerPath(): string {
  return pathResolver.rootResolve(LEDGER_RELATIVE_PATH);
}

function readLedger(): AdhocRunTally[] {
  try {
    const filePath = ledgerPath();
    if (!safeExistsSync(filePath)) return [];
    const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Record a successful ad-hoc run; returns the updated success count. */
export function recordAdhocPipelineRun(relativePath: string): number {
  const normalized = String(relativePath || '').trim();
  if (!normalized) return 0;
  try {
    const filePath = ledgerPath();
    safeMkdir(path.dirname(filePath), { recursive: true });
    const entries = readLedger();
    const existing = entries.find((entry) => entry.path === normalized);
    let count = 1;
    if (existing) {
      existing.count += 1;
      existing.last_at = new Date().toISOString();
      count = existing.count;
    } else {
      entries.push({ path: normalized, count: 1, last_at: new Date().toISOString() });
    }
    // Rotate by recency when over cap.
    const trimmed = entries
      .sort((left, right) => right.last_at.localeCompare(left.last_at))
      .slice(0, MAX_ENTRIES);
    safeWriteFile(filePath, `${JSON.stringify(trimmed, null, 2)}\n`);
    return count;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`[promotion-candidates] tally failed: ${detail}`);
    return 0;
  }
}

/** Paths whose success count reached the promotion threshold. */
export function listPromotionCandidates(
  minRuns: number = PROMOTION_CANDIDATE_MIN_RUNS
): AdhocRunTally[] {
  return readLedger()
    .filter(
      (entry) => entry.count >= minRuns && safeExistsSync(pathResolver.rootResolve(entry.path))
    )
    .sort((left, right) => right.count - left.count);
}
