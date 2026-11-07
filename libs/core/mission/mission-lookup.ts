/**
 * Lenient mission lookup for read / display / context paths.
 *
 * `pathResolver.findMissionPath` is strict: an id that exists in several
 * tenants (OWNER_AMBIGUOUS) or whose directory holds a state this process may
 * not see (OWNER_NOT_VISIBLE) throws, because lifecycle and mutation callers
 * must never treat such a mission as absent (a `find ?? create` caller would
 * make a second copy). A path that only reads, renders or resolves optional
 * context should degrade instead: no mission context, 404 — and nothing about
 * the other scopes is disclosed.
 *
 * The finder is passed in rather than imported so callers keep using their
 * own (and tests' mocked) `findMissionPath`:
 *
 *   missionPathOrNull(findMissionPath, missionId)
 *
 * Which call sites are strict is pinned by tests/mission-lookup-boundary.test.ts.
 */

export type MissionPathFinder = (missionId: string) => string | null | undefined;

const REFUSAL_CODES = new Set(['OWNER_NOT_FOUND', 'OWNER_AMBIGUOUS', 'OWNER_NOT_VISIBLE']);

/** True for the lookup refusals a read path treats as "no such mission". */
export function isMissionLookupRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && REFUSAL_CODES.has(code);
}

/**
 * Run a per-mission read (`loadState(id)` and the like) inside a LIST loop: an
 * ambiguous or not-visible mission is skipped instead of aborting the whole
 * listing. A list shows what this process may see, so skipping is the
 * conservative answer; a single-item read keeps the strict lookup.
 */
export function readOrNullOnMissionRefusal<T>(read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (isMissionLookupRefusal(error)) return null;
    throw error;
  }
}

/** The mission directory, or null when it is absent, ambiguous or not visible. */
export function missionPathOrNull(find: MissionPathFinder, missionId: string): string | null {
  try {
    return find(missionId) ?? null;
  } catch (error) {
    if (isMissionLookupRefusal(error)) return null;
    throw error;
  }
}

/**
 * Is the mission scope actually gone — for existence audits (e.g. the NHI
 * orphan scan), where {@link missionPathOrNull}'s degrade-to-null contract is
 * too coarse: OWNER_NOT_VISIBLE and OWNER_AMBIGUOUS prove the mission EXISTS
 * (its directory is on disk), so the affiliation is intact and the identity
 * is not orphaned — the mission is merely outside this process's tenant view.
 * Only a genuine absence (null from the finder, or a strict OWNER_NOT_FOUND)
 * counts as missing. Any other refusal still means "could not establish",
 * which an audit must not silently turn into either verdict — rethrow.
 */
export function missionScopeMissing(find: MissionPathFinder, missionId: string): boolean {
  try {
    return find(missionId) == null;
  } catch (error) {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    if (code === 'OWNER_NOT_FOUND') return true;
    if (isMissionLookupRefusal(error)) return false;
    throw error;
  }
}
