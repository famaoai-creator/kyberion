/** Durable organizational responsibilities, separate from access and execution roles. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { nowIso } from '../foundation/time.js';
import { safeExistsSync, safeReaddir } from '../secure-io.js';
import { digest, fail, requireGrant } from '../surface/surface-management-contract.js';
import { loadTeamRoleIndex } from '../mission/mission-team-index.js';
import {
  memberProfileDir,
  memberProfilePath,
  readMemberProfile,
  isValidMemberId,
} from './member-registry.js';
import {
  assertOrganizationId,
  loadOrganizationOperationalState,
  organizationOperationalStatePath,
  recordPath,
} from './organization-operating-model-persistence.js';
import type { OrganizationOperationalState } from './organization-operating-model.js';
import {
  authorizeOrganizationPeople,
  recordPeopleManagementAudit,
  verifyOrganizationPeople,
  withOrganizationPeopleMutation,
  withPeopleResources,
  type OrganizationPeopleAuthorization,
} from './organization-people-access.js';
import {
  listManagedOrganizationAgents,
  showManagedOrganizationAgent,
} from './organization-agent-management.js';

export type OrganizationParticipantsAuthorization = OrganizationPeopleAuthorization;
export interface OrganizationParticipantRecord {
  assignment_id: string;
  organization_id: string;
  tenant_slug: string;
  tier: 'confidential';
  actor: string;
  role_ids: string[];
  status: 'active' | 'removed';
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface OrganizationParticipantCandidate {
  actor: string;
  display_name: string;
  kind: 'human' | 'agent' | 'service';
  identity_status: string;
  is_local_owner: boolean;
  accountable_human_id?: string;
  home_organization_id?: string;
}
export interface OrganizationParticipant
  extends OrganizationParticipantRecord, OrganizationParticipantCandidate {
  version: string;
}
const SCHEMA = pathResolver.rootResolve(
  'knowledge/product/schemas/organization-participant.schema.json'
);
const FILE = 'participant.json';

function assignmentId(actor: string): string {
  if (
    !/^user:[a-z][a-z0-9-]{1,30}$/.test(actor) &&
    !/^kyberion:\/\/agent\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[a-z][a-z0-9-]*$/.test(actor)
  )
    fail('invalid_actor', 400, 'Select a registered human or agent identity.');
  return 'participant-' + createHash('sha256').update(actor).digest('hex').slice(0, 32);
}
function participantPath(
  auth: Pick<OrganizationPeopleAuthorization, 'tenantSlug'>,
  organizationId: string,
  actor: string
): string {
  return recordPath(
    'participants',
    assignmentId(actor),
    FILE,
    organizationId,
    'confidential',
    auth.tenantSlug
  );
}
function validate(
  record: OrganizationParticipantRecord,
  file: string
): OrganizationParticipantRecord {
  const value = defineCatalog<OrganizationParticipantRecord>({
    id: 'organization-participant',
    path: file,
    schema: SCHEMA,
  }).validate(record, file);
  if (value.assignment_id !== assignmentId(value.actor))
    fail('invalid_state', 409, 'Participant identity is inconsistent.');
  return value;
}
function read(
  auth: Pick<OrganizationPeopleAuthorization, 'tenantSlug'>,
  organizationId: string,
  actor: string
): OrganizationParticipantRecord | null {
  const file = participantPath(auth, organizationId, actor);
  const raw = readJsonIfPresent<OrganizationParticipantRecord>(file);
  if (!raw) return null;
  const record = validate(raw, file);
  if (
    record.actor !== actor ||
    record.organization_id !== organizationId ||
    record.tenant_slug !== auth.tenantSlug ||
    record.tier !== 'confidential'
  )
    fail('invalid_state', 409, 'Participant scope is inconsistent.');
  return record;
}

/** Pure governed reader for directory projections; retains the caller's IO authority. */
export function readOrganizationResponsibilityForActor(
  scope: { organizationId: string; tenantSlug: string },
  actor: string
): OrganizationParticipantRecord | null {
  return read({ tenantSlug: scope.tenantSlug }, scope.organizationId, actor);
}

export function listOrganizationBusinessRoles(): Array<{
  role_id: string;
  name: string;
  description?: string;
}> {
  return Object.entries(loadTeamRoleIndex())
    .map(([role_id, role]) => ({ role_id, name: role_id, description: role.description }))
    .sort((a, b) => a.role_id.localeCompare(b.role_id));
}
function roles(value: string[]): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    value.some((role) => typeof role !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(role))
  )
    fail('invalid_roles', 400, 'Select up to 32 valid organizational responsibilities.');
  const known = new Set(listOrganizationBusinessRoles().map((role) => role.role_id));
  if (value.some((role) => !known.has(role)))
    fail('invalid_roles', 400, 'An organizational role is not registered.');
  return [...new Set(value)].sort();
}

export async function listManagedOrganizations(
  request: OrganizationPeopleAuthorization
): Promise<OrganizationOperationalState[]> {
  const auth = await authorizeOrganizationPeople(request);
  const root = pathResolver.rootResolve('active/organizations/confidential/' + auth.tenantSlug);
  const ids =
    auth.allowedOrganizationIds === 'all'
      ? await withPeopleResources(auth, { reads: [root] }, () =>
          safeExistsSync(root)
            ? safeReaddir(root).filter((id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id))
            : []
        )
      : [...auth.allowedOrganizationIds];
  const result: OrganizationOperationalState[] = [];
  for (const id of ids) {
    assertOrganizationId(id);
    const state = await withPeopleResources(
      auth,
      {
        organizationId: id,
        reads: [organizationOperationalStatePath(id, 'confidential', auth.tenantSlug)],
      },
      () =>
        loadOrganizationOperationalState(id, { tier: 'confidential', tenantSlug: auth.tenantSlug })
    );
    if (state && state.status !== 'archived') result.push(state);
  }
  return result.sort((a, b) => a.organization_id.localeCompare(b.organization_id));
}

export async function listOrganizationParticipantCandidates(
  request: OrganizationPeopleAuthorization
): Promise<OrganizationParticipantCandidate[]> {
  const auth = await authorizeOrganizationPeople(request);
  const ids = await withPeopleResources(auth, { reads: [memberProfileDir()] }, () =>
    safeExistsSync(memberProfileDir())
      ? safeReaddir(memberProfileDir())
          .filter((name) => name.endsWith('.json'))
          .map((name) => name.slice(0, -5))
          .filter((id) => isValidMemberId(id) && !id.startsWith('ext-'))
      : []
  );
  const people = await withPeopleResources(
    auth,
    { reads: ids.map((id) => memberProfilePath(id)) },
    () =>
      ids
        .map((id) => readMemberProfile(id))
        .filter(
          (member) =>
            member?.status === 'active' &&
            member.memberships.some((m) => m.tenant_slug === auth.tenantSlug)
        )
        .map((member) => ({
          actor: 'user:' + member!.member_id,
          display_name: member!.display_name,
          kind: 'human' as const,
          identity_status: member!.status,
          is_local_owner: member!.member_id === 'owner',
        }))
  );
  const agents = await listManagedOrganizationAgents(auth);
  return [
    ...people,
    ...agents.map((agent) => ({
      actor: agent.nhi_id,
      display_name: agent.display_name,
      kind: agent.kind,
      identity_status: agent.lifecycle_status,
      is_local_owner: false,
      accountable_human_id: agent.accountable_human_id,
      home_organization_id: agent.home_organization_id,
    })),
  ].sort((a, b) => a.actor.localeCompare(b.actor));
}

async function candidate(
  auth: OrganizationPeopleAuthorization,
  actor: string
): Promise<OrganizationParticipantCandidate> {
  assignmentId(actor);
  if (actor.startsWith('user:')) {
    const id = actor.slice(5);
    if (!isValidMemberId(id)) fail('invalid_actor', 400, 'Select a registered human.');
    const member = await withPeopleResources(auth, { reads: [memberProfilePath(id)] }, () =>
      readMemberProfile(id)
    );
    if (
      !member ||
      member.status !== 'active' ||
      !member.memberships.some((m) => m.tenant_slug === auth.tenantSlug)
    )
      fail(
        'invalid_actor',
        400,
        'The human must be active in this tenant before assigning responsibilities.'
      );
    return {
      actor,
      display_name: member.display_name,
      kind: 'human',
      identity_status: member.status,
      is_local_owner: id === 'owner',
    };
  }
  const agent = await showManagedOrganizationAgent(auth, actor);
  if (!agent || agent.lifecycle_status === 'retired')
    fail(
      'invalid_actor',
      400,
      'The agent must belong to an authorized organization in this tenant and must not be retired.'
    );
  return {
    actor,
    display_name: agent.display_name,
    kind: agent.kind,
    identity_status: agent.lifecycle_status,
    is_local_owner: false,
    accountable_human_id: agent.accountable_human_id,
    home_organization_id: agent.home_organization_id,
  };
}

async function availableOrganization(
  auth: OrganizationPeopleAuthorization,
  organizationId: string
): Promise<void> {
  requireGrant(auth.allowedOrganizationIds, organizationId);
  const state = await withPeopleResources(
    auth,
    {
      organizationId,
      reads: [organizationOperationalStatePath(organizationId, 'confidential', auth.tenantSlug)],
    },
    () =>
      loadOrganizationOperationalState(organizationId, {
        tier: 'confidential',
        tenantSlug: auth.tenantSlug,
      })
  );
  if (!state || state.status === 'archived')
    fail('not_found', 404, 'An available organization in this tenant is required.');
}

export async function listOrganizationParticipants(
  request: OrganizationPeopleAuthorization,
  organizationId: string
): Promise<OrganizationParticipant[]> {
  const auth = await authorizeOrganizationPeople(request, organizationId);
  await availableOrganization(auth, organizationId);
  const root = path.join(
    pathResolver.organizationStateDir(organizationId, 'confidential', auth.tenantSlug),
    'participants'
  );
  const ids = await withPeopleResources(auth, { organizationId, reads: [root] }, () =>
    safeExistsSync(root)
      ? safeReaddir(root).filter((id) => /^participant-[a-f0-9]{32}$/.test(id))
      : []
  );
  const records = await withPeopleResources(
    auth,
    {
      organizationId,
      reads: ids.map((id) =>
        recordPath('participants', id, FILE, organizationId, 'confidential', auth.tenantSlug)
      ),
    },
    () =>
      ids.map((id) => {
        const file = recordPath(
          'participants',
          id,
          FILE,
          organizationId,
          'confidential',
          auth.tenantSlug
        );
        const raw = readJsonIfPresent<OrganizationParticipantRecord>(file);
        if (!raw) fail('invalid_state', 409, 'A participant record is incomplete.');
        const record = validate(raw, file);
        if (
          record.assignment_id !== id ||
          record.organization_id !== organizationId ||
          record.tenant_slug !== auth.tenantSlug
        )
          fail('invalid_state', 409, 'Participant scope is inconsistent.');
        return record;
      })
  );
  const rows: OrganizationParticipant[] = [];
  for (const record of records) {
    let identity: OrganizationParticipantCandidate;
    try {
      identity = await candidate(auth, record.actor);
    } catch {
      identity = {
        actor: record.actor,
        display_name: record.actor,
        kind: record.actor.startsWith('user:') ? 'human' : 'agent',
        identity_status: 'unavailable',
        is_local_owner: record.actor === 'user:owner',
      };
    }
    rows.push({ ...record, ...identity, version: digest(record) });
  }
  return rows.sort((a, b) => a.actor.localeCompare(b.actor));
}

export async function setOrganizationParticipant(
  request: OrganizationPeopleAuthorization,
  input: { organizationId: string; actor: string; roleIds: string[]; expectedVersion?: string }
): Promise<{ participant: OrganizationParticipant; version: string }> {
  const auth = await authorizeOrganizationPeople(request, input.organizationId, true);
  const roleIds = roles(input.roleIds);
  const file = participantPath(auth, input.organizationId, input.actor);
  return withOrganizationPeopleMutation(async () => {
    await verifyOrganizationPeople(auth);
    await availableOrganization(auth, input.organizationId);
    const identity = await candidate(auth, input.actor);
    const current = await withPeopleResources(
      auth,
      { organizationId: input.organizationId, reads: [file] },
      () => read(auth, input.organizationId, input.actor)
    );
    if (current ? input.expectedVersion !== digest(current) : input.expectedVersion !== undefined)
      fail('conflict', 409, 'The assignment changed or already exists. Refresh before retrying.');
    if (
      current?.status === 'active' &&
      JSON.stringify(current.role_ids) === JSON.stringify(roleIds)
    )
      return {
        participant: { ...current, ...identity, version: digest(current) },
        version: digest(current),
      };
    const now = nowIso();
    const record: OrganizationParticipantRecord = {
      assignment_id: assignmentId(input.actor),
      organization_id: input.organizationId,
      tenant_slug: auth.tenantSlug,
      tier: 'confidential',
      actor: input.actor,
      role_ids: roleIds,
      status: 'active',
      revision: (current?.revision ?? 0) + 1,
      created_at: current?.created_at ?? now,
      updated_at: now,
    };
    await recordPeopleManagementAudit(
      auth,
      'organization.participant.assign.requested',
      input.actor,
      { organization_id: input.organizationId, role_ids: roleIds }
    );
    await withPeopleResources(
      auth,
      { organizationId: input.organizationId, reads: [file], writes: [file] },
      () => writeJson(file, validate(record, file))
    );
    await recordPeopleManagementAudit(auth, 'organization.participant.assign', input.actor, {
      organization_id: input.organizationId,
      role_ids: roleIds,
    });
    return {
      participant: { ...record, ...identity, version: digest(record) },
      version: digest(record),
    };
  });
}

export async function removeOrganizationParticipant(
  request: OrganizationPeopleAuthorization,
  input: { organizationId: string; actor: string; expectedVersion: string }
): Promise<{ participant: OrganizationParticipant; version: string }> {
  const auth = await authorizeOrganizationPeople(request, input.organizationId, true);
  const file = participantPath(auth, input.organizationId, input.actor);
  return withOrganizationPeopleMutation(async () => {
    await verifyOrganizationPeople(auth);
    await availableOrganization(auth, input.organizationId);
    const current = await withPeopleResources(
      auth,
      { organizationId: input.organizationId, reads: [file] },
      () => read(auth, input.organizationId, input.actor)
    );
    if (!current) fail('not_found', 404, 'Participant assignment not found.');
    if (input.expectedVersion !== digest(current))
      fail('conflict', 409, 'The assignment changed. Refresh before retrying.');
    const record: OrganizationParticipantRecord =
      current.status === 'removed'
        ? current
        : { ...current, status: 'removed', revision: current.revision + 1, updated_at: nowIso() };
    await recordPeopleManagementAudit(
      auth,
      'organization.participant.remove.requested',
      input.actor,
      { organization_id: input.organizationId }
    );
    await withPeopleResources(
      auth,
      { organizationId: input.organizationId, reads: [file], writes: [file] },
      () => writeJson(file, validate(record, file))
    );
    await recordPeopleManagementAudit(auth, 'organization.participant.remove', input.actor, {
      organization_id: input.organizationId,
    });
    let identity: OrganizationParticipantCandidate;
    try {
      identity = await candidate(auth, input.actor);
    } catch {
      identity = {
        actor: input.actor,
        display_name: input.actor,
        kind: input.actor.startsWith('user:') ? 'human' : 'agent',
        identity_status: 'unavailable',
        is_local_owner: input.actor === 'user:owner',
      };
    }
    return {
      participant: { ...record, ...identity, version: digest(record) },
      version: digest(record),
    };
  });
}
