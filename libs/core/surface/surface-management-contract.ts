/** Strict transport-independent management commands, versions and validation. */
import { createHash } from 'node:crypto';
import { humanActor } from '../actor.js';
import { isValidTenantSlug } from '../entity-scope.js';
import { assertOrganizationId } from '../organization/organization-operating-model-persistence.js';
import { assertManagedProjectId } from '../project/project-management.js';
import type {
  OrganizationOperationalState,
  OrganizationPurposeRecord,
} from '../organization/organization-operating-model.js';
import type { ProjectRecord } from '../project/project-registry.js';
import type { ProjectOperationalState } from '../project/project-operational-state-registry.js';
export interface SurfaceManagementAuthorization {
  actorId: string;
  memberId: string;
  tenantSlug: string;
  /** Verified principal expiry; checked again after lock acquisition. */
  expiresAt?: string;
  allowedOrganizationIds: readonly string[] | 'all';
  allowedProjectIds: readonly string[] | 'all';
}
export type SurfaceManagementCommand =
  | { operation: 'organization.create'; requestId: string; name: string; purpose?: string }
  | {
      operation: 'organization.update';
      requestId: string;
      organizationId: string;
      expectedVersion: string;
      name?: string;
      purpose?: string;
    }
  | {
      operation: 'project.create';
      requestId: string;
      organizationId: string;
      name: string;
      summary: string;
    }
  | {
      operation: 'project.update';
      requestId: string;
      organizationId: string;
      projectId: string;
      expectedVersion: string;
      name?: string;
      summary?: string;
    };
export type SurfaceManagementResource =
  | {
      kind: 'organization';
      state: OrganizationOperationalState;
      purpose: OrganizationPurposeRecord | null;
    }
  | { kind: 'project'; record: ProjectRecord; state: ProjectOperationalState | null };
export interface SurfaceManagementResult {
  operation: SurfaceManagementCommand['operation'];
  organizationId: string;
  projectId?: string;
  resource: SurfaceManagementResource;
  version: string;
  replayed: boolean;
  auditPending?: true;
}
export class SurfaceManagementError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'SurfaceManagementError';
  }
}
export function fail(code: string, status: number, message: string): never {
  throw new SurfaceManagementError(code, status, message);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)])
    );
  return value;
}
export function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function organizationManagementVersion(
  state: OrganizationOperationalState,
  purpose: OrganizationPurposeRecord | null | undefined
): string {
  return digest({ state, purpose: purpose ?? null });
}
export function projectManagementVersion(
  record: ProjectRecord,
  state?: ProjectOperationalState | null
): string {
  return digest({ record, state: state ?? null });
}
export function version(resource: SurfaceManagementResource): string {
  return resource.kind === 'organization'
    ? organizationManagementVersion(resource.state, resource.purpose)
    : projectManagementVersion(resource.record, resource.state);
}
export function checkAuthorizationShape(auth: SurfaceManagementAuthorization): void {
  try {
    if (
      !auth ||
      !isValidTenantSlug(auth.tenantSlug) ||
      auth.actorId !== humanActor(auth.memberId).id
    )
      fail('forbidden', 403, 'A verified member and tenant are required.');
  } catch {
    fail('forbidden', 403, 'A verified member and tenant are required.');
  }
  if (
    auth.expiresAt !== undefined &&
    (typeof auth.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(auth.expiresAt)) ||
      Date.parse(auth.expiresAt) <= Date.now())
  )
    fail('expired', 403, 'The authenticated principal has expired.');
  for (const grants of [auth.allowedOrganizationIds, auth.allowedProjectIds])
    if (grants !== 'all' && (!Array.isArray(grants) || grants.some((id) => typeof id !== 'string')))
      fail('forbidden', 403, 'Entity grants are invalid.');
}
export function requireGrant(grants: readonly string[] | 'all', id: string): void {
  if (grants !== 'all' && !grants.includes(id))
    fail('forbidden', 403, 'This entity is outside the authorized scope.');
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\u0000'))
    fail('invalid_command', 400, label + ' is invalid.');
  return value;
}
export function validate(command: SurfaceManagementCommand): void {
  if (!command || typeof command !== 'object' || Array.isArray(command))
    fail('invalid_command', 400, 'A management command is required.');
  const keys: Record<string, string[]> = {
    'organization.create': ['operation', 'requestId', 'name', 'purpose'],
    'organization.update': [
      'operation',
      'requestId',
      'organizationId',
      'expectedVersion',
      'name',
      'purpose',
    ],
    'project.create': ['operation', 'requestId', 'organizationId', 'name', 'summary'],
    'project.update': [
      'operation',
      'requestId',
      'organizationId',
      'projectId',
      'expectedVersion',
      'name',
      'summary',
    ],
  };
  const allowed = Object.hasOwn(keys, command.operation) ? keys[command.operation] : undefined;
  if (!allowed || Object.keys(command).some((key) => !allowed.includes(key)))
    fail('invalid_command', 400, 'Unsupported management fields.');
  if (
    typeof command.requestId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(command.requestId)
  )
    fail('invalid_command', 400, 'A valid idempotency requestId is required.');
  if (command.operation.endsWith('.create')) text(command.name, 'Name', 200);
  if (command.name !== undefined) text(command.name, 'Name', 200);
  if ('purpose' in command && command.purpose !== undefined)
    text(command.purpose, 'Purpose', 10000);
  if ('summary' in command && command.summary !== undefined)
    text(command.summary, 'Summary', 10000);
  if (command.operation === 'project.create') text(command.summary, 'Summary', 10000);
  try {
    if ('organizationId' in command) assertOrganizationId(command.organizationId);
    if ('projectId' in command && assertManagedProjectId(command.projectId) !== command.projectId)
      throw new Error('Non-canonical project ID');
  } catch {
    fail('invalid_command', 400, 'Entity identifiers are invalid.');
  }
  if (command.operation === 'organization.update' || command.operation === 'project.update') {
    if (!/^[a-f0-9]{64}$/.test(command.expectedVersion))
      fail('invalid_command', 400, 'A current expectedVersion is required.');
    if (
      command.name === undefined &&
      (command.operation === 'organization.update'
        ? command.purpose === undefined
        : command.summary === undefined)
    )
      fail('invalid_command', 400, 'At least one metadata field is required.');
  }
}
