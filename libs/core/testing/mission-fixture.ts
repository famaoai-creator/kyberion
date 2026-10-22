/**
 * Teardown helpers for tests that exercise the governed mission tree.
 *
 * Some tests must run against the real `missionDir()` / `tenantMissionDir()`
 * resolvers: they cover the path resolution, the tier guard, or the journal
 * writers themselves, and a stubbed root would not exercise what they claim
 * to. Those tests are then responsible for leaving the tree exactly as they
 * found it — which is where they have historically failed, accumulating
 * hundreds of state-less mission directories that no lifecycle verb could see
 * (`pnpm mission:residue --check` is the guard).
 *
 * `removeMissionFixture` reclaims one such fixture completely: the mission
 * directory, and then every parent left empty by its removal up to (but never
 * including) the mission tier root. Removing the mission directory alone was
 * the other half of the leak — the tenant-slug directory around it survived,
 * so `alpha-team/`, `other-tenant/` and friends stayed behind as empty shells.
 */
import * as path from 'node:path';
import { missionDir, tenantMissionDir, rootDir } from '../path-resolver.js';
import { safeExistsSync, safeReaddir, safeRmSync } from '../secure-io.js';
import { withExecutionContext } from '../authority.js';

export type MissionTier = 'personal' | 'confidential' | 'public';

export interface MissionFixtureRef {
  missionId: string;
  tier?: MissionTier;
  tenantSlug?: string;
}

/** Repo-relative roots that a fixture sweep must never delete or ascend past. */
function isTierRoot(dir: string): boolean {
  const relative = path.relative(rootDir(), dir).split(path.sep).join('/');
  return (
    relative === '' ||
    relative === 'active' ||
    relative === 'active/missions' ||
    /^active\/missions\/(personal|confidential|public)$/.test(relative) ||
    /^knowledge\/personal\/missions$/.test(relative) ||
    relative.startsWith('..')
  );
}

function isEmptyDir(dir: string): boolean {
  try {
    return safeReaddir(dir).length === 0;
  } catch {
    return false;
  }
}

/**
 * Remove a mission fixture and any directory its removal left empty.
 *
 * Safe to call for a fixture that was never created, or twice: a missing path
 * is a no-op, never an error, so it can sit unconditionally in an `afterEach`.
 */
export function removeMissionFixture(ref: MissionFixtureRef): void {
  // The mission tree is write-guarded, and a test's own persona at teardown
  // time is whatever its last case left behind — often nothing. Carry the
  // authority that owns `active/missions/` here so teardown works from any
  // caller instead of silently failing and leaving the fixture in place.
  withExecutionContext('mission_controller', () => removeMissionFixtureUnguarded(ref), 'worker');
}

function removeMissionFixtureUnguarded(ref: MissionFixtureRef): void {
  const tier = ref.tier ?? 'confidential';
  const dir = ref.tenantSlug
    ? tenantMissionDir(ref.missionId, ref.tenantSlug, tier)
    : missionDir(ref.missionId, tier);

  if (safeExistsSync(dir)) {
    try {
      safeRmSync(dir, { recursive: true, force: true });
    } catch {
      return;
    }
  }

  // Walk up, reclaiming the tenant-slug (and any other) parents this fixture
  // brought into being, stopping at the tier root that belongs to the repo.
  let parent = path.dirname(dir);
  while (!isTierRoot(parent) && safeExistsSync(parent) && isEmptyDir(parent)) {
    try {
      safeRmSync(parent, { recursive: true, force: true });
    } catch {
      return;
    }
    parent = path.dirname(parent);
  }
}

/** Remove several fixtures; convenient for a suite that seeds more than one. */
export function removeMissionFixtures(refs: readonly MissionFixtureRef[]): void {
  for (const ref of refs) removeMissionFixture(ref);
}
