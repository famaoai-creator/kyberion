import { settingsDraftContext } from '../../lib/use-settings-draft';
import { frontDeskFetch } from '../../lib/front-desk-fetch';
import {
  getFrontDeskAuthRevision,
  readFrontDeskRequestToken,
} from '../../lib/front-desk-auth-token';
export type Scope = { tenant: string; organizationId: string; projectId: string };
export type Operation =
  'organization.create' | 'organization.update' | 'project.create' | 'project.update';
export type Mutation = Scope & {
  operation: Operation;
  requestId: string;
  contextId: string;
  name: string;
  purpose?: string;
  summary?: string;
  expectedVersion?: string;
};
type Entity = { id: string; name: string; status: string; version: string };
export type ManagementData = {
  ok: true;
  contextId: string;
  actorId: string;
  tenants: { slug: string; name: string }[];
  organizations: Pick<Entity, 'id' | 'name' | 'status'>[];
  projects: (Pick<Entity, 'id' | 'name' | 'status'> & { organization_id: string })[];
  selected: Scope;
  canManage: boolean;
  capabilities: {
    createOrganization: boolean;
    createProject: boolean;
    editOrganization: boolean;
    editProject: boolean;
  };
  organization: (Entity & { purpose: string }) | null;
  project: (Entity & { summary: string }) | null;
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
const entity = (v: unknown) => record(v) && text(v.id) && text(v.name) && text(v.status);
export function parseManagement(value: unknown): ManagementData | null {
  if (
    !record(value) ||
    value.ok !== true ||
    !text(value.contextId) ||
    !/^[a-f0-9]{64}$/.test(value.contextId) ||
    !text(value.actorId) ||
    !/^user:.+/.test(value.actorId) ||
    !Array.isArray(value.tenants) ||
    !value.tenants.every((v) => record(v) && text(v.slug) && text(v.name)) ||
    !Array.isArray(value.organizations) ||
    !value.organizations.every(entity) ||
    !Array.isArray(value.projects) ||
    !value.projects.every((v) => entity(v) && record(v) && text(v.organization_id)) ||
    !record(value.selected) ||
    !text(value.selected.tenant) ||
    !['organizationId', 'projectId'].every(
      (k) =>
        (value.selected as Record<string, unknown>)[k] === null ||
        text((value.selected as Record<string, unknown>)[k])
    ) ||
    typeof value.canManage !== 'boolean' ||
    !record(value.capabilities) ||
    !['createOrganization', 'createProject', 'editOrganization', 'editProject'].every(
      (k) => typeof (value.capabilities as Record<string, unknown>)[k] === 'boolean'
    ) ||
    !(
      value.organization === null ||
      (entity(value.organization) &&
        record(value.organization) &&
        text(value.organization.purpose) &&
        text(value.organization.version))
    ) ||
    !(
      value.project === null ||
      (entity(value.project) &&
        record(value.project) &&
        text(value.project.summary) &&
        text(value.project.version))
    )
  )
    return null;
  return {
    ...value,
    selected: {
      tenant: value.selected.tenant,
      organizationId: value.selected.organizationId ?? '',
      projectId: value.selected.projectId ?? '',
    },
  } as ManagementData;
}
export function scopeQuery(scope: Scope): string {
  const params = new URLSearchParams();
  if (scope.tenant) params.set('tenant', scope.tenant);
  if (scope.organizationId) params.set('organization_id', scope.organizationId);
  if (scope.projectId) params.set('project_id', scope.projectId);
  return params.toString();
}
/** Only the verified surface origin/path is retained. Never forward credential query or fragment. */
export function missionLink(value: unknown, scope: Scope): string | null {
  if (!record(value) || value.ok !== true || !text(value.chronos_url)) return null;
  try {
    const url = new URL(value.chronos_url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.search = scopeQuery(scope);
    url.searchParams.set('section', 'missions');
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}
export class ManagementError extends Error {
  constructor(public readonly kind: 'expired' | 'forbidden' | 'conflict' | 'failed' | 'uncertain') {
    super(kind);
  }
}
async function payload(response: Response): Promise<Record<string, unknown>> {
  const data: unknown = await response.json().catch(() => null);
  if (response.status === 401) throw new ManagementError('expired');
  if (response.status === 403) throw new ManagementError('forbidden');
  if (response.status === 409 && record(data) && data.error_code === 'busy')
    throw new ManagementError('failed');
  if (response.status === 409 || response.status === 412) throw new ManagementError('conflict');
  if (!response.ok || !record(data) || data.ok !== true) throw new ManagementError('failed');
  return data;
}
export async function loadManagement(scope: Scope, signal: AbortSignal): Promise<ManagementData> {
  const data = parseManagement(
    await payload(await frontDeskFetch('/api/management?' + scopeQuery(scope), { signal }))
  );
  if (!data) throw new ManagementError('failed');
  return data;
}
export async function submitManagement(input: Mutation, signal: AbortSignal) {
  const data = await payload(
    await frontDeskFetch('/api/management', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenant: input.tenant,
        operation: input.operation,
        requestId: input.requestId,
        contextId: input.contextId,
        name: input.name,
        ...(input.operation.startsWith('organization')
          ? { purpose: input.purpose }
          : { summary: input.summary }),
        ...(input.operation !== 'organization.create'
          ? { organizationId: input.organizationId }
          : {}),
        ...(input.operation === 'project.update' ? { projectId: input.projectId } : {}),
        ...(input.operation.endsWith('update') ? { expectedVersion: input.expectedVersion } : {}),
      }),
    })
  );
  if (
    !record(data.result) ||
    !text(data.result.organizationId) ||
    (data.result.projectId !== undefined && !text(data.result.projectId)) ||
    !text(data.result.version) ||
    typeof data.result.replayed !== 'boolean'
  )
    throw new ManagementError('uncertain');
  return {
    organizationId: data.result.organizationId,
    projectId: data.result.projectId as string | undefined,
    auditPending: data.result.auditPending === true,
  };
}
/** Per-page fence also guards late response parsing and post-unmount completion. */
export class ManagementFence {
  private generation = 0;
  private serverIdentity: string | undefined;
  private actorId: string | undefined;
  hasIdentity() {
    return this.serverIdentity !== undefined;
  }
  acceptsSnapshot(data: ManagementData): boolean {
    return this.actorId !== undefined && data.actorId === this.actorId;
  }
  bindIdentity(value: unknown): boolean {
    const identity = settingsDraftContext(value);
    if (!identity || (this.serverIdentity !== undefined && this.serverIdentity !== identity))
      return false;
    if (!record(value) || !record(value.member) || !text(value.member.member_id)) return false;
    this.serverIdentity = identity;
    this.actorId = 'user:' + value.member.member_id;
    return true;
  }
  async verifyIdentity(signal: AbortSignal): Promise<boolean> {
    const value = await payload(await frontDeskFetch('/api/me', { signal }));
    return this.bindIdentity(value);
  }
  private controller = new AbortController();
  private identity = this.auth();
  private auth() {
    try {
      return JSON.stringify([getFrontDeskAuthRevision(), readFrontDeskRequestToken()]);
    } catch {
      return undefined;
    }
  }
  authChanged() {
    return this.identity === undefined || this.identity !== this.auth();
  }
  reset() {
    this.controller.abort();
    this.controller = new AbortController();
    this.generation++;
  }
  begin() {
    const generation = this.generation;
    return {
      signal: this.controller.signal,
      current: () =>
        generation === this.generation && !this.controller.signal.aborted && !this.authChanged(),
    };
  }
}

/** Omit untouched text so a name-only edit cannot change its approval state. */
export function managementDescription(operation: Operation, value: string, data: ManagementData) {
  const organization = operation.startsWith('organization');
  const creating = operation.endsWith('create');
  const original = (organization ? data.organization?.purpose : data.project?.summary) ?? '';
  const text = value.trim();
  const required = operation === 'project.create' || (!creating && !!original.trim());
  const changed = !!text && (creating || (value !== original && text !== original));
  return {
    required,
    valid: !required || !!text,
    fields: changed ? (organization ? { purpose: text } : { summary: text }) : {},
  };
}
