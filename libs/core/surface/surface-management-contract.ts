/** Transport-independent management commands, versions and errors. */
import { createHash } from 'node:crypto';
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
export function requireGrant(grants: readonly string[] | 'all', id: string): void {
  if (grants !== 'all' && !grants.includes(id))
    fail('forbidden', 403, 'This entity is outside the authorized scope.');
}
