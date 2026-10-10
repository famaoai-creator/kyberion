/** Governed, create-only organization initialization and bounded metadata edits. */
import { nowIso } from '../foundation/time.js';
import { readTextFile } from '../foundation/text.js';
import {
  safeCreateExclusiveFileSync,
  safeExistsSync,
  safeUnlinkSync,
  safeWriteFile,
} from '../secure-io.js';
import {
  buildOrganizationScaffold,
  buildOrganizationPurposeRecord,
  type BuildOrganizationScaffoldInput,
  type OrganizationScaffold,
} from './organization-operating-model-operations.js';
import {
  loadOrganizationOperationalState,
  loadOrganizationPurpose,
  organizationOperationalStatePath,
  organizationPurposePath,
  saveOrganizationOperationalState,
  saveOrganizationPurpose,
} from './organization-operating-model-persistence.js';
import type { OrganizationTier } from './organization-operating-model.js';

export function createManagedOrganization(
  input: BuildOrganizationScaffoldInput
): OrganizationScaffold & { saved_paths: string[] } {
  const statePath = organizationOperationalStatePath(
    input.organizationId,
    input.tier,
    input.tenantSlug,
    input.rootDir
  );
  const purposePath = organizationPurposePath(
    input.organizationId,
    input.tier,
    input.tenantSlug,
    input.rootDir
  );
  // An orphan purpose must never be overwritten by an initialization retry.
  if (safeExistsSync(statePath) || safeExistsSync(purposePath))
    throw new Error('Organization already exists: ' + input.organizationId);
  const scaffold = buildOrganizationScaffold(input);
  const created: string[] = [];
  try {
    safeCreateExclusiveFileSync(statePath, JSON.stringify(scaffold.state, null, 2));
    created.push(statePath);
    if (scaffold.purpose) {
      safeCreateExclusiveFileSync(purposePath, JSON.stringify(scaffold.purpose, null, 2));
      created.push(purposePath);
    }
    return { ...scaffold, saved_paths: created };
  } catch (error) {
    for (const file of created.reverse()) safeUnlinkSync(file);
    throw error;
  }
}

export interface OrganizationMetadataScope {
  organizationId: string;
  tenantSlug: string;
  tier: OrganizationTier;
  rootDir?: string;
}

/** No lifecycle, membership, objective, or reconciliation side effects. */
export function updateManagedOrganizationMetadata(
  scope: OrganizationMetadataScope,
  patch: { name?: string; purpose?: string }
): OrganizationScaffold {
  if (
    !Object.keys(patch).length ||
    Object.keys(patch).some((key) => key !== 'name' && key !== 'purpose')
  )
    throw new Error('Only organization name and purpose may be edited.');
  const state = loadOrganizationOperationalState(scope.organizationId, scope);
  if (!state) throw new Error('Organization not found: ' + scope.organizationId);
  const purpose = loadOrganizationPurpose(scope.organizationId, scope);
  const nextState = {
    ...state,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    updated_at: nowIso(),
  };
  const nextPurpose = purpose
    ? {
        ...purpose,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.purpose !== undefined ? { purpose: patch.purpose } : {}),
        ...(patch.purpose !== undefined && patch.purpose !== purpose.purpose
          ? { approval_state: 'draft' as const }
          : {}),
        updated_at: nowIso(),
      }
    : patch.purpose !== undefined
      ? buildOrganizationPurposeRecord({
          ...scope,
          name: nextState.name,
          purpose: patch.purpose,
          ownerRole: 'operator',
        })
      : undefined;
  const statePath = organizationOperationalStatePath(
    scope.organizationId,
    scope.tier,
    scope.tenantSlug,
    scope.rootDir
  );
  const purposePath = organizationPurposePath(
    scope.organizationId,
    scope.tier,
    scope.tenantSlug,
    scope.rootDir
  );
  const oldState = readTextFile(statePath);
  const oldPurpose = safeExistsSync(purposePath) ? readTextFile(purposePath) : null;
  try {
    saveOrganizationOperationalState(nextState, scope);
    if (nextPurpose) saveOrganizationPurpose(nextPurpose, scope);
  } catch (error) {
    safeWriteFile(statePath, oldState);
    if (oldPurpose !== null) safeWriteFile(purposePath, oldPurpose);
    else if (safeExistsSync(purposePath)) safeUnlinkSync(purposePath);
    throw error;
  }
  return { state: nextState, ...(nextPurpose ? { purpose: nextPurpose } : {}) };
}
