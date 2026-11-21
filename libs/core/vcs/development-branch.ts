/**
 * Canonical branch names and validator for bounded mission-scoped development.
 *
 * Legacy continuous development uses `agent/kyberion-development`; parallel
 * factory missions may isolate on `agent/factory-<slug>` branches. Arbitrary
 * branches (`main`, feature branches, path-like strings) are rejected fail-closed.
 */

export const MISSION_DEVELOPMENT_BRANCH = 'agent/kyberion-development';
export const FACTORY_BRANCH_PATTERN = /^agent\/factory-[a-z0-9][a-z0-9-]{1,60}$/u;

export function resolveMissionDevelopmentBranch(branch?: string): string {
  if (branch === undefined) return MISSION_DEVELOPMENT_BRANCH;
  if (
    typeof branch === 'string' &&
    branch === branch.trim() &&
    (branch === MISSION_DEVELOPMENT_BRANCH || FACTORY_BRANCH_PATTERN.test(branch))
  ) {
    return branch;
  }
  throw new Error(
    `Invalid development branch "${String(branch)}": must be "${MISSION_DEVELOPMENT_BRANCH}" or match ${FACTORY_BRANCH_PATTERN.source}`
  );
}
