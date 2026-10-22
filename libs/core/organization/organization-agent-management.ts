/** Tenant/organization-owner facade over the canonical NHI journal. */
import {
  activateAgentIdentity,
  withAgentIdentityStoreAccess,
  getAgentIdentity,
  getAgentIdentityRevision,
  issueAgentIdentity,
  listAgentIdentities,
  reassignAgentIdentityAccountability,
  retireAgentIdentity,
  suspendAgentIdentity,
  type AgentIdentityRecord,
  type AgentIdentityKind,
  type AgentIdentityLifecycleStatus,
} from '../agent/agent-identity.js';
import { digest, fail, requireGrant } from '../surface/surface-management-contract.js';
import {
  authorizeOrganizationPeople,
  recordPeopleManagementAudit,
  verifyOrganizationPeople,
  withOrganizationPeopleMutation,
  withPeopleResources,
  withPeopleResourcesSync,
  type OrganizationPeopleAuthorization,
} from './organization-people-access.js';
import { memberProfilePath, readMemberProfile, isValidMemberId } from './member-registry.js';
import { withExecutionContextAsync } from '../authority.js';
import {
  loadOrganizationOperationalState,
  organizationOperationalStatePath,
} from './organization-operating-model-persistence.js';

export interface ManagedOrganizationAgent {
  nhi_id: string;
  display_name: string;
  kind: AgentIdentityKind;
  lifecycle_status: AgentIdentityLifecycleStatus;
  accountable_human_id: string;
  home_organization_id: string;
  tenant_slug: string;
  version: string;
}

async function inJournal<T>(
  auth: OrganizationPeopleAuthorization,
  _writing: boolean,
  action: () => T
): Promise<T> {
  return withExecutionContextAsync(
    'mission_controller',
    () =>
      withAgentIdentityStoreAccess(
        (resources, run) =>
          withPeopleResourcesSync(auth, { ...resources, role: 'mission_controller' }, run),
        action
      ),
    undefined,
    auth.tenantSlug
  );
}

function visible(auth: OrganizationPeopleAuthorization, record: AgentIdentityRecord): boolean {
  return (
    record.affiliation.tenant_slug === auth.tenantSlug &&
    (auth.allowedOrganizationIds === 'all' ||
      auth.allowedOrganizationIds.includes(record.affiliation.organization_id))
  );
}

function view(record: AgentIdentityRecord): ManagedOrganizationAgent {
  return {
    nhi_id: record.nhi_id,
    display_name: record.display_name,
    kind: record.kind,
    lifecycle_status: record.lifecycle_status,
    accountable_human_id: record.accountable_human_id,
    home_organization_id: record.affiliation.organization_id,
    tenant_slug: record.affiliation.tenant_slug!,
    version: digest({ record, revision: getAgentIdentityRevision(record.nhi_id) }),
  };
}

async function accountableMember(
  auth: OrganizationPeopleAuthorization,
  actor: string
): Promise<string> {
  const id = typeof actor === 'string' && actor.startsWith('user:') ? actor.slice(5) : '';
  if (!isValidMemberId(id))
    fail('invalid_accountable', 400, 'Select a registered human member as accountable owner.');
  const member = await withPeopleResources(auth, { reads: [memberProfilePath(id)] }, () =>
    readMemberProfile(id)
  );
  if (
    !member ||
    member.status !== 'active' ||
    !member.memberships.some((m) => m.tenant_slug === auth.tenantSlug)
  )
    fail('invalid_accountable', 400, 'The accountable human must be active in this tenant.');
  return 'user:' + member.member_id;
}

export async function listManagedOrganizationAgents(
  request: OrganizationPeopleAuthorization,
  query: { organizationId?: string; includeRetired?: boolean } = {}
): Promise<ManagedOrganizationAgent[]> {
  const auth = await authorizeOrganizationPeople(request, query.organizationId);
  return inJournal(auth, false, () =>
    listAgentIdentities(
      query.organizationId ? { organization_id: query.organizationId } : undefined
    )
      .filter(
        (record) =>
          visible(auth, record) && (query.includeRetired || record.lifecycle_status !== 'retired')
      )
      .map(view)
      .sort((a, b) => a.nhi_id.localeCompare(b.nhi_id))
  );
}

export async function showManagedOrganizationAgent(
  request: OrganizationPeopleAuthorization,
  nhiId: string
): Promise<ManagedOrganizationAgent | null> {
  const auth = await authorizeOrganizationPeople(request);
  return inJournal(auth, false, () => {
    const record = getAgentIdentity(nhiId);
    return record && visible(auth, record) ? view(record) : null;
  });
}

export async function issueManagedOrganizationAgent(
  request: OrganizationPeopleAuthorization,
  input: {
    organizationId: string;
    slug: string;
    kind?: AgentIdentityKind;
    displayName?: string;
    accountableHumanId: string;
    providerHint?: string;
    modelHint?: string;
  }
): Promise<ManagedOrganizationAgent> {
  const auth = await authorizeOrganizationPeople(request, input.organizationId, true);
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(input.slug) ||
    (input.kind && !['agent', 'service'].includes(input.kind))
  )
    fail('invalid_agent', 400, 'A valid agent slug and kind are required.');
  if (
    input.displayName !== undefined &&
    (typeof input.displayName !== 'string' ||
      !input.displayName.trim() ||
      input.displayName.length > 200)
  )
    fail('invalid_agent', 400, 'The agent display name must contain 1–200 characters.');
  for (const value of [input.providerHint, input.modelHint])
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 200))
      fail('invalid_agent', 400, 'Provider and model hints must contain 1–200 characters.');
  return withOrganizationPeopleMutation(async () => {
    await verifyOrganizationPeople(auth);
    const organization = await withPeopleResources(
      auth,
      {
        organizationId: input.organizationId,
        reads: [
          organizationOperationalStatePath(input.organizationId, 'confidential', auth.tenantSlug),
        ],
      },
      () =>
        loadOrganizationOperationalState(input.organizationId, {
          tier: 'confidential',
          tenantSlug: auth.tenantSlug,
        })
    );
    if (!organization || organization.status === 'archived')
      fail('not_found', 404, 'An available organization in this tenant is required.');
    const accountable = await accountableMember(auth, input.accountableHumanId);
    await recordPeopleManagementAudit(auth, 'organization.agent.issue.requested', input.slug, {
      organization_id: input.organizationId,
      accountable_human_id: accountable,
    });
    let result: ManagedOrganizationAgent;
    try {
      result = await inJournal(auth, true, () =>
        view(
          issueAgentIdentity({
            organizationId: input.organizationId,
            slug: input.slug,
            kind: input.kind ?? 'agent',
            displayName: input.displayName?.trim(),
            accountableHumanId: accountable,
            affiliation: { tenant_slug: auth.tenantSlug },
            providerHint: input.providerHint,
            modelHint: input.modelHint,
          })
        )
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AgentIdentityConflictError')
        fail('conflict', 409, error.message);
      throw error;
    }
    await recordPeopleManagementAudit(auth, 'organization.agent.issue', result.nhi_id, {
      organization_id: input.organizationId,
    });
    return result;
  });
}

async function mutateAgent(
  request: OrganizationPeopleAuthorization,
  input: { nhiId: string; expectedVersion: string },
  operation: string,
  mutate: (
    auth: OrganizationPeopleAuthorization,
    record: AgentIdentityRecord
  ) => Promise<AgentIdentityRecord>
): Promise<ManagedOrganizationAgent> {
  const auth = await authorizeOrganizationPeople(request, undefined, true);
  if (typeof input.expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedVersion))
    fail('invalid_version', 400, 'Refresh the agent before changing it.');
  return withOrganizationPeopleMutation(async () => {
    await verifyOrganizationPeople(auth);
    const current = await inJournal(auth, false, () => {
      const record = getAgentIdentity(input.nhiId);
      if (!record || !visible(auth, record))
        fail('not_found', 404, 'Agent not found in the authorized organizations.');
      requireGrant(auth.allowedOrganizationIds, record.affiliation.organization_id);
      if (view(record).version !== input.expectedVersion)
        fail('conflict', 409, 'The agent changed. Refresh before retrying.');
      if (record.lifecycle_status === 'retired')
        fail('conflict', 409, 'Retired identities are terminal.');
      return record;
    });
    await recordPeopleManagementAudit(auth, operation + '.requested', current.nhi_id, {
      organization_id: current.affiliation.organization_id,
    });
    let record: AgentIdentityRecord;
    try {
      record = await mutate(auth, current);
    } catch (error) {
      if (
        error instanceof Error &&
        ['AgentIdentityConflictError', 'AgentIdentityLifecycleError'].includes(error.name)
      )
        fail('conflict', 409, error.message);
      if (error instanceof Error && error.name === 'AgentIdentityNotFoundError')
        fail('not_found', 404, error.message);
      throw error;
    }
    const result = await inJournal(auth, false, () => view(record));
    await recordPeopleManagementAudit(auth, operation, result.nhi_id, {
      organization_id: result.home_organization_id,
    });
    return result;
  });
}

export async function changeManagedOrganizationAgentLifecycle(
  auth: OrganizationPeopleAuthorization,
  input: {
    nhiId: string;
    action: 'activate' | 'suspend' | 'retire';
    reason?: string;
    expectedVersion: string;
  }
): Promise<ManagedOrganizationAgent> {
  if (!['activate', 'suspend', 'retire'].includes(input.action))
    fail('invalid_action', 400, 'Choose activate, suspend or retire.');
  if (
    input.reason !== undefined &&
    (typeof input.reason !== 'string' || input.reason.length > 1000)
  )
    fail('invalid_reason', 400, 'A reason must contain at most 1000 characters.');
  if (input.action === 'retire' && !input.reason?.trim())
    fail('invalid_reason', 400, 'Retirement requires a reason of 1–1000 characters.');
  return mutateAgent(auth, input, 'organization.agent.' + input.action, async (owned, record) => {
    if (input.action === 'activate') {
      await accountableMember(owned, record.accountable_human_id);
      const state = await withPeopleResources(
        owned,
        {
          organizationId: record.affiliation.organization_id,
          reads: [
            organizationOperationalStatePath(
              record.affiliation.organization_id,
              'confidential',
              owned.tenantSlug
            ),
          ],
        },
        () =>
          loadOrganizationOperationalState(record.affiliation.organization_id, {
            tier: 'confidential',
            tenantSlug: owned.tenantSlug,
          })
      );
      if (!state || state.status === 'archived')
        fail('invalid_scope', 409, 'Restore the home organization before activating this agent.');
    }
    return inJournal(owned, true, () =>
      input.action === 'activate'
        ? activateAgentIdentity(record.nhi_id)
        : input.action === 'suspend'
          ? suspendAgentIdentity(record.nhi_id, input.reason)
          : retireAgentIdentity(record.nhi_id, input.reason!.trim())
    );
  });
}

export async function reassignManagedOrganizationAgentAccountable(
  auth: OrganizationPeopleAuthorization,
  input: { nhiId: string; accountableHumanId: string; reason: string; expectedVersion: string }
): Promise<ManagedOrganizationAgent> {
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000)
    fail(
      'invalid_reason',
      400,
      'Accountability reassignment requires a reason of 1–1000 characters.'
    );
  return mutateAgent(
    auth,
    input,
    'organization.agent.reassign-accountable',
    async (owned, record) => {
      const accountable = await accountableMember(owned, input.accountableHumanId);
      return inJournal(owned, true, () =>
        reassignAgentIdentityAccountability({
          nhiId: record.nhi_id,
          accountableHumanId: accountable,
          expectedAccountableHumanId: record.accountable_human_id,
          reason: input.reason,
        })
      );
    }
  );
}
