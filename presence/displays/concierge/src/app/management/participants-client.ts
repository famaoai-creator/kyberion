import { frontDeskFetch } from '../../lib/front-desk-fetch';
import { ManagementError, scopeQuery, type Scope } from './management-client';

export type ParticipantCandidate = {
  actor: string;
  display_name: string;
  kind: 'human' | 'agent' | 'service';
  identity_status: string;
  is_local_owner: boolean;
  accountable_human_id?: string;
  home_organization_id?: string;
};
export type OrganizationParticipant = ParticipantCandidate & {
  organization_id: string;
  role_ids: string[];
  status: 'active' | 'removed';
  version: string;
};
export type ManagedAgent = {
  nhi_id: string;
  display_name: string;
  kind: 'agent' | 'service';
  lifecycle_status: 'provisioned' | 'active' | 'suspended' | 'retired';
  accountable_human_id: string;
  home_organization_id: string;
  tenant_slug: string;
  version: string;
};
export type ParticipantsData = {
  ok: true;
  contextId: string;
  actorId: string;
  tenant: string;
  organizationId: string;
  participants: OrganizationParticipant[];
  candidates: ParticipantCandidate[];
  agents: ManagedAgent[];
  roles: { role_id: string; name: string; description?: string }[];
};
export type ParticipantsCommand =
  | { operation: 'participant.assign'; actor: string; roleIds: string[]; expectedVersion?: string }
  | { operation: 'participant.remove'; actor: string; expectedVersion: string }
  | { operation: 'agent.issue'; slug: string; displayName: string; accountableHumanId: string }
  | {
      operation: 'agent.lifecycle';
      nhiId: string;
      action: 'activate' | 'suspend' | 'retire';
      reason: string;
      expectedVersion: string;
    }
  | {
      operation: 'agent.accountable';
      nhiId: string;
      accountableHumanId: string;
      reason: string;
      expectedVersion: string;
    };

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === 'string';
const candidate = (value: unknown): value is ParticipantCandidate =>
  record(value) &&
  text(value.actor) &&
  text(value.display_name) &&
  ['human', 'agent', 'service'].includes(String(value.kind)) &&
  text(value.identity_status) &&
  typeof value.is_local_owner === 'boolean' &&
  (value.accountable_human_id === undefined || text(value.accountable_human_id)) &&
  (value.home_organization_id === undefined || text(value.home_organization_id));
const agent = (value: unknown): value is ManagedAgent =>
  record(value) &&
  text(value.nhi_id) &&
  text(value.display_name) &&
  ['agent', 'service'].includes(String(value.kind)) &&
  ['provisioned', 'active', 'suspended', 'retired'].includes(String(value.lifecycle_status)) &&
  ['accountable_human_id', 'home_organization_id', 'tenant_slug', 'version'].every((key) =>
    text(value[key])
  );

export function parseParticipants(value: unknown): ParticipantsData | null {
  if (
    !record(value) ||
    value.ok !== true ||
    !['contextId', 'actorId', 'tenant', 'organizationId'].every((key) => text(value[key])) ||
    !/^[a-f0-9]{64}$/.test(String(value.contextId)) ||
    !Array.isArray(value.candidates) ||
    !value.candidates.every(candidate) ||
    !Array.isArray(value.agents) ||
    !value.agents.every(agent) ||
    !Array.isArray(value.participants) ||
    !value.participants.every(
      (row) =>
        record(row) &&
        text(row.organization_id) &&
        Array.isArray(row.role_ids) &&
        row.role_ids.every(text) &&
        ['active', 'removed'].includes(String(row.status)) &&
        text(row.version) &&
        candidate(row)
    ) ||
    !Array.isArray(value.roles) ||
    !value.roles.every(
      (row) =>
        record(row) &&
        text(row.role_id) &&
        text(row.name) &&
        (row.description === undefined || text(row.description))
    )
  )
    return null;
  if (
    value.agents.some((row) => row.tenant_slug !== value.tenant) ||
    value.participants.some((row) => row.organization_id !== value.organizationId)
  )
    return null;
  return value as ParticipantsData;
}

async function read(response: Response): Promise<unknown> {
  const value: unknown = await response.json().catch(() => null);
  if (response.status === 401) throw new ManagementError('expired');
  if (response.status === 403) throw new ManagementError('forbidden');
  if (response.status === 409 || response.status === 412) throw new ManagementError('conflict');
  if (!response.ok || !record(value) || value.ok !== true) throw new ManagementError('failed');
  return value;
}

export async function loadParticipants(scope: Scope, contextId: string, signal: AbortSignal) {
  const value = parseParticipants(
    await read(
      await frontDeskFetch(
        '/api/management/participants?' + scopeQuery({ ...scope, projectId: '' }),
        { signal }
      )
    )
  );
  if (
    !value ||
    value.contextId !== contextId ||
    value.tenant !== scope.tenant ||
    value.organizationId !== scope.organizationId
  )
    throw new ManagementError('forbidden');
  return value;
}

export async function submitParticipantCommand(
  scope: Scope,
  contextId: string,
  command: ParticipantsCommand,
  signal: AbortSignal
): Promise<void> {
  await read(
    await frontDeskFetch('/api/management/participants', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenant: scope.tenant,
        organizationId: scope.organizationId,
        contextId,
        ...command,
      }),
    })
  );
}
