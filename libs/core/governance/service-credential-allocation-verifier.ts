/** Personal ownership stays unchanged; a verified standing grant bounds tenant use. */
import { withStoreGrant } from '../authority.js';
import { credentialExecutionIdentity } from '../foundation/credential-binding.js';
import {
  grantStatusAt,
  listGrants,
  loadGrant,
  verifyGrantBasis,
  type GrantRecord,
} from './grant-store.js';
import type { ServiceBindingRecord } from '../service/service-binding-registry.js';
import { validateBindingOwner } from '../service/service-binding-owner.js';
import { isValidTenantSlug } from '../foundation/scope.js';

import type { ServiceAllocationUseScope } from './service-credential-allocation.js';

/** Does not load material or infer consent from a tenant role or stored granted_by label. */
export function verifyServiceCredentialAllocation(
  selected: ServiceBindingRecord,
  scope: ServiceAllocationUseScope,
  options: { grantId?: string; action?: string } = {}
): GrantRecord {
  const denied = () =>
    new Error('[SERVICE_CREDENTIAL_ALLOCATION_DENIED] No current owner-authorized allocation');
  const identity = credentialExecutionIdentity();
  if (
    !scope.tenant_slug ||
    !isValidTenantSlug(scope.tenant_slug) ||
    identity.tenantSlug !== scope.tenant_slug ||
    identity.missionId !== scope.mission_id ||
    identity.taskId !== scope.task_id ||
    validateBindingOwner(selected).length ||
    selected.owner_kind !== 'person' ||
    !selected.owner_ref ||
    selected.tenant_slug
  )
    throw denied();
  return withStoreGrant(
    'credential_allocation_reader',
    () => {
      const records = options.grantId
        ? [loadGrant(scope.tenant_slug, options.grantId)].filter((grant): grant is GrantRecord =>
            Boolean(grant)
          )
        : listGrants({ tenant_slug: scope.tenant_slug, capability: 'credential.use' });
      const matches = records.filter((grant) => {
        const allocation = grant.scope.service_allocation;
        return (
          grant.capability === 'credential.use' &&
          grant.scope.tenant_slug === scope.tenant_slug &&
          allocation &&
          allocation.binding_id === selected.binding_id &&
          allocation.target === selected.target &&
          allocation.owner_ref === selected.owner_ref &&
          allocation.service_id === (selected.service_id || selected.service_type) &&
          allocation.secret_refs.length === selected.secret_refs.length &&
          allocation.secret_refs.every((ref) => selected.secret_refs.includes(ref)) &&
          allocation.allowed_actions.every((action) => selected.allowed_actions.includes(action)) &&
          (!options.action || allocation.allowed_actions.includes(options.action)) &&
          (!allocation.project_id || allocation.project_id === scope.project_id) &&
          (!allocation.mission_id || allocation.mission_id === scope.mission_id) &&
          (!allocation.task_id || allocation.task_id === scope.task_id) &&
          grantStatusAt(grant, new Date()) === 'active' &&
          verifyGrantBasis(grant)
        );
      });
      if (matches.length !== 1) throw denied();
      return matches[0]!;
    },
    {
      tenantSlug: scope.tenant_slug,
      identity: { missionId: identity.missionId ?? null, taskId: identity.taskId ?? null },
    }
  );
}
