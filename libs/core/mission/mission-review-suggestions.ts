import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  loadJsonIfPresent,
  safeExistsSync,
  safeReaddir,
} from '../secure-io.js';

/**
 * Mission review-suggestion surfacing.
 *
 * `review-task` receipts land per-mission under `evidence/reviews/`, and
 * non-blocking findings have no resolution tracking — they used to die inside
 * the receipt once the mission archived. This module makes them visible
 * across missions without mutating anything: a read-only aggregation an
 * operator (or an agent triaging follow-ups) can page through.
 */

export interface MissionReviewSuggestion {
  mission_id: string;
  tier: string;
  archived: boolean;
  review_id: string;
  review_task_id: string;
  verdict: string;
  severity: string;
  category: string;
  description: string;
  location?: string;
  reviewed_at?: string;
}

function safeMissionDir(candidate: string): string | null {
  try {
    return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
  } catch {
    return null;
  }
}

function tryReaddir(dirPath: string): string[] {
  try {
    return safeReaddir(dirPath);
  } catch {
    return [];
  }
}

function isMissionDir(dirPath: string): boolean {
  return (
    safeExistsSync(path.join(dirPath, 'mission-state.json')) ||
    safeExistsSync(path.join(dirPath, 'evidence'))
  );
}

/** Mission dirs under any layout: markers (mission-state.json / evidence/)
 *  identify the mission regardless of flat vs tenant-nested placement — both
 *  layouts exist under public/, and flat dirs exist under confidential/. */
function collectMissionDirs(
  rootDir: string
): Array<{ missionPath: string; tier: string; archived: boolean }> {
  const roots: Array<{ dir: string; tier: string; archived: boolean }> = [
    { dir: 'active/missions/public', tier: 'public', archived: false },
    { dir: 'active/missions/personal', tier: 'personal', archived: false },
    { dir: 'active/missions/confidential', tier: 'confidential', archived: false },
    { dir: 'active/missions', tier: 'legacy', archived: false },
    { dir: 'active/archive/missions', tier: 'archive', archived: true },
  ];
  const tierSegments = new Set(['public', 'confidential', 'personal', 'ephemeral']);
  const found: Array<{ missionPath: string; tier: string; archived: boolean }> = [];
  for (const root of roots) {
    const absRoot = safeMissionDir(path.join(rootDir, root.dir));
    if (!absRoot || !safeExistsSync(absRoot)) continue;
    for (const entry of tryReaddir(absRoot)) {
      if (root.tier === 'legacy' && tierSegments.has(entry)) continue;
      const candidate = safeMissionDir(path.join(absRoot, entry));
      if (!candidate) continue;
      if (isMissionDir(candidate)) {
        found.push({ missionPath: candidate, tier: root.tier, archived: root.archived });
        continue;
      }
      // Not a mission dir → treat as a tenant segment and probe one level in.
      for (const nested of tryReaddir(candidate)) {
        const nestedPath = safeMissionDir(path.join(candidate, nested));
        if (nestedPath && isMissionDir(nestedPath)) {
          found.push({ missionPath: nestedPath, tier: root.tier, archived: root.archived });
        }
      }
    }
  }
  return found;
}

/**
 * Non-blocking review findings across all missions (archived included —
 * suggestions survive missions). Blocking findings are excluded by default
 * because they already gate the task; pass `includeBlocking` for a full
 * triage view. Receipts that fail to parse or lack `findings` are skipped —
 * this is a read-only view, never a gate.
 */
export function collectMissionReviewSuggestions(
  options: { rootDir?: string; includeBlocking?: boolean } = {}
): MissionReviewSuggestion[] {
  const rootDir = options.rootDir || pathResolver.rootDir();
  const includeBlocking = options.includeBlocking ?? false;
  const out: MissionReviewSuggestion[] = [];
  for (const { missionPath, tier, archived } of collectMissionDirs(rootDir)) {
    const reviewsDir = path.join(missionPath, 'evidence', 'reviews');
    if (!safeExistsSync(reviewsDir)) continue;
    for (const file of tryReaddir(reviewsDir).filter((name) => name.endsWith('.json'))) {
      const receipt = loadJsonIfPresent(path.join(reviewsDir, file)) as Record<
        string,
        unknown
      > | null;
      const findings = receipt?.findings;
      if (!receipt || !Array.isArray(findings)) continue;
      const missionId = String(receipt.mission_id || path.basename(missionPath));
      for (const finding of findings) {
        const severity = String((finding as Record<string, unknown>)?.severity || 'unknown');
        if (severity === 'blocking' && !includeBlocking) continue;
        const record = finding as Record<string, unknown>;
        out.push({
          mission_id: missionId,
          tier,
          archived,
          review_id: String(receipt.review_id || file.replace(/\.json$/, '')),
          review_task_id: String(receipt.review_task_id || ''),
          verdict: String(receipt.verdict || ''),
          severity,
          category: String(record.category || 'general'),
          description: String(record.description || ''),
          ...(record.location ? { location: String(record.location) } : {}),
          ...(receipt.reviewed_at ? { reviewed_at: String(receipt.reviewed_at) } : {}),
        });
      }
    }
  }
  // Group by mission first (the CLI prints a header per mission — a global
  // time sort would interleave and re-print headers), newest within each.
  return out.sort(
    (a, b) =>
      a.mission_id.localeCompare(b.mission_id) ||
      String(b.reviewed_at || '').localeCompare(String(a.reviewed_at || ''))
  );
}
