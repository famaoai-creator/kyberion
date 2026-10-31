import type { ResourceAccessScope } from './resource-access-scope.js';
import { isValidTenantSlug } from './scope.js';

/**
 * Read-only role for one archived tenant mission's state
 * (`active/archive/missions/<personal|confidential>/<tenant>/<id>/mission-state.json`).
 * libs/core/mission/mission-decision-lock.ts `loadDecisionCaseMissionState`
 * assumes it, bound to the tenant and inside {@link archivedMissionStateCapability},
 * to find a finished bolt's decision case: no mission authority, no write, no
 * other file of the mission folder or the tenant's archive.
 */
export const ARCHIVED_MISSION_STATE_READER_ROLE = 'archived_mission_state_reader';

const TENANT_ARCHIVE_STATE =
  /^active\/archive\/missions\/(personal|confidential)\/([a-z][a-z0-9-]{1,30})\/[A-Za-z0-9][A-Za-z0-9._-]{0,160}\/mission-state\.json$/u;

/**
 * The exact deny-only capability of an archived mission state read: that one
 * `mission-state.json` (repo-relative) of the tenant's own archive partition
 * and the product schema, nothing else.
 */
export function archivedMissionStateCapability(
  tenantSlug: string,
  relativeStatePath: string
): ResourceAccessScope {
  const match = relativeStatePath.match(TENANT_ARCHIVE_STATE);
  if (!isValidTenantSlug(tenantSlug) || !match || match[2] !== tenantSlug)
    throw new Error('[RESOURCE_SCOPE_INVALID] Invalid archived mission state path');
  return {
    tenantSlug,
    readExact: [relativeStatePath],
    writeExact: [],
    mkdirExact: [],
    allowProductKnowledgeRead: true,
  };
}

export function isArchivedMissionStateCapability(scope: ResourceAccessScope | undefined): boolean {
  if (
    !scope ||
    scope.organizationId ||
    scope.projectId ||
    scope.allowProductKnowledgeRead !== true ||
    (scope.metadataExact?.length ?? 0) > 0 ||
    scope.readExact.length !== 1 ||
    scope.writeExact.length > 0 ||
    (scope.appendExact?.length ?? 0) > 0 ||
    scope.mkdirExact.length > 0
  )
    return false;
  try {
    archivedMissionStateCapability(scope.tenantSlug, scope.readExact[0]!);
    return true;
  } catch {
    return false;
  }
}
