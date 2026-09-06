import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';
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
const LEDGER_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/adhoc-pipeline-run-ledger.schema.json'
);
const MAX_ENTRIES = 200;
export const PROMOTION_CANDIDATE_MIN_RUNS = 3;

function ledgerPath(): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(LEDGER_RELATIVE_PATH), {
    allowMissingLeaf: true,
  });
}

function candidatePath(relativePath: string): string | null {
  try {
    return assertSafeRepositoryPath(pathResolver.rootResolve(relativePath), {
      allowMissingLeaf: true,
    });
  } catch {
    return null;
  }
}

function ledgerCatalog(filePath: string) {
  return defineCatalog<AdhocRunTally[]>({
    id: 'adhoc-pipeline-run-ledger',
    path: filePath,
    schema: LEDGER_SCHEMA_PATH,
  });
}

export function loadAdhocRunLedgerAtPath(filePath: string): AdhocRunTally[] {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[PROMOTION_CANDIDATES] ledger must be a regular file: ${filePath}`);
  }
  return ledgerCatalog(safeFilePath).load();
}

function readLedger(): AdhocRunTally[] {
  try {
    const filePath = ledgerPath();
    if (!safeExistsSync(filePath)) return [];
    return loadAdhocRunLedgerAtPath(filePath);
  } catch {
    return [];
  }
}

/** Record a successful ad-hoc run; returns the updated success count. */
export function recordAdhocPipelineRun(relativePath: string): number {
  const normalized = String(relativePath || '').trim();
  if (!normalized) return 0;
  try {
    if (!candidatePath(normalized)) return 0;
    const filePath = ledgerPath();
    safeMkdir(path.dirname(filePath), { recursive: true });
    const entries = readLedger();
    const existing = entries.find((entry) => entry.path === normalized);
    let count = 1;
    const recordedAt = nowIso();
    if (existing) {
      existing.count += 1;
      existing.last_at = recordedAt;
      count = existing.count;
    } else {
      entries.push({ path: normalized, count: 1, last_at: recordedAt });
    }
    // Rotate by recency when over cap.
    const trimmed = entries
      .sort((left, right) => right.last_at.localeCompare(left.last_at))
      .slice(0, MAX_ENTRIES);
    const validated = ledgerCatalog(filePath).validate(trimmed, filePath);
    safeWriteFile(filePath, `${JSON.stringify(validated, null, 2)}\n`);
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
    .filter((entry) => {
      const filePath = candidatePath(entry.path);
      return entry.count >= minRuns && filePath !== null && safeExistsSync(filePath);
    })
    .sort((left, right) => right.count - left.count);
}
