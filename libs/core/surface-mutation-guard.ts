/**
 * Framework-neutral mutation guard for UI surfaces.
 *
 * Extracted from operator-surface's api-guard so every mutating surface
 * (operator-surface /api/inbox, concierge approvals/outcomes, …) shares one
 * decision: allow bearer token (KYBERION_API_TOKEN /
 * KYBERION_LOCALADMIN_TOKEN), allow same-origin, otherwise 403.
 */

import { getRegisteredEnvText } from './foundation/env.js';
import {
  findChronosTokenRegistration,
  isValidChronosScopeId,
  matchesChronosToken,
  type ChronosAccessRole,
  type ChronosTokenRegistration,
} from './chronos-access-registry.js';
import { isValidTenantSlug } from './entity-scope.js';
import type { OsKnowledgeTier } from './cloudflare-os-control-plane.js';

export interface SurfaceMutationRequest {
  url: string;
  getHeader(name: string): string | null;
}

export interface SurfaceMutationDecision {
  ok: boolean;
  status: number;
  reason: string;
}

/** Extract a bearer credential without deciding whether it is authorized. */
export function extractSurfaceBearerToken(authorization: string | null | undefined): string {
  return typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : '';
}

function resolveBearerToken(request: SurfaceMutationRequest): string {
  return extractSurfaceBearerToken(request.getHeader('authorization'));
}

export function authorizeSurfaceMutation(request: SurfaceMutationRequest): SurfaceMutationDecision {
  const url = new URL(request.url);
  const apiToken = getRegisteredEnvText('KYBERION_API_TOKEN');
  const localadminToken = getRegisteredEnvText('KYBERION_LOCALADMIN_TOKEN');
  const token = resolveBearerToken(request);
  if (matchesChronosToken(token, apiToken) || matchesChronosToken(token, localadminToken)) {
    return { ok: true, status: 200, reason: 'token' };
  }

  const origin = request.getHeader('origin') || '';
  if (origin) {
    try {
      if (new URL(origin).origin === url.origin) {
        return { ok: true, status: 200, reason: 'same-origin' };
      }
    } catch {
      // fall through to deny
    }
  }

  return {
    ok: false,
    status: 403,
    reason:
      'Forbidden. Use the same origin or provide KYBERION_API_TOKEN / KYBERION_LOCALADMIN_TOKEN.',
  };
}

/** Framework-neutral viewer scope shared by HTTP surfaces. */
export interface SurfaceViewerScope {
  role: ChronosAccessRole;
  tenantSlugs: string[] | 'all';
  organizationIds: string[] | 'all';
  projectIds: string[] | 'all';
  tierAccess: OsKnowledgeTier[];
  source: 'token' | 'loopback' | 'anonymous';
  principalId?: string;
}

export interface SurfaceViewerTokenResolution {
  role: ChronosAccessRole;
  registration?: ChronosTokenRegistration;
}

export interface SurfaceViewerConfiguredCredential {
  token?: string;
  role: ChronosAccessRole;
}

export interface SurfaceViewerScopeResolutionOptions {
  /** Credential already extracted by the framework adapter. */
  token?: string | null;
  /** Whether the request was proven to originate from loopback. */
  local?: boolean;
  /** Server-owned tenant binding for unregistered remote credentials. */
  serverTenant?: string | null;
  registrations?: readonly ChronosTokenRegistration[] | null;
  apiToken?: string;
  localadminToken?: string;
  configuredCredentials?: readonly SurfaceViewerConfiguredCredential[];
  /** Role granted by a separately verified loopback compatibility path. */
  loopbackRole?: ChronosAccessRole;
  /** Allow the framework adapter's loopback compatibility path. */
  allowLoopback?: boolean;
  /** Bind loopback viewers to the server tenant instead of all tenants. */
  loopbackUsesServerTenant?: boolean;
  /** Surface-specific masking may remove personal, but never add, access. */
  allowPersonalTier?: boolean;
  principalIds?: Partial<Record<ChronosAccessRole, string>>;
}

/**
 * Resolve the shared credential boundary used by HTTP surfaces.
 *
 * Registration-backed scopes remain authoritative; configured API tokens are
 * only the compatibility fallback and never gain tenant or tier claims here.
 * Surface-specific request handling must still narrow the returned scope.
 */
export function resolveSurfaceViewerToken(
  token: string,
  options: {
    registrations?: readonly ChronosTokenRegistration[] | null;
    apiToken?: string;
    localadminToken?: string;
    configuredCredentials?: readonly SurfaceViewerConfiguredCredential[];
  } = {}
): SurfaceViewerTokenResolution | null {
  if (!token) return null;
  const registration = options.registrations
    ? findChronosTokenRegistration(token, [...options.registrations])
    : null;
  if (registration) return { role: registration.role, registration };
  if (matchesChronosToken(token, options.localadminToken)) return { role: 'localadmin' };
  if (matchesChronosToken(token, options.apiToken)) return { role: 'readonly' };
  const configured = options.configuredCredentials?.find((credential) =>
    matchesChronosToken(token, credential.token)
  );
  if (configured) return { role: configured.role };
  return null;
}

export class SurfaceViewerScopeError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string
  ) {
    super(message);
    this.name = 'SurfaceViewerScopeError';
  }
}

const ROLE_TIER_ACCESS: Record<ChronosAccessRole, readonly OsKnowledgeTier[]> = {
  readonly: ['public', 'confidential'],
  localadmin: ['personal', 'confidential', 'public'],
};

export function defaultSurfaceViewerTierAccess(role: ChronosAccessRole): OsKnowledgeTier[] {
  return [...ROLE_TIER_ACCESS[role]];
}

/** A registration can narrow a role, but never widen its tier policy. */
export function resolveSurfaceViewerTierAccess(
  role: ChronosAccessRole,
  requested?: readonly OsKnowledgeTier[]
): OsKnowledgeTier[] {
  const allowed = ROLE_TIER_ACCESS[role];
  if (!requested) return [...allowed];
  const normalized = [...new Set(requested)];
  if (!normalized.length || normalized.some((tier) => !allowed.includes(tier))) {
    throw new SurfaceViewerScopeError(403, `viewer tier scope exceeds the ${role} role policy.`);
  }
  return normalized;
}

/**
 * Materialize one server-derived viewer scope for every HTTP surface.
 * Framework adapters own request parsing and loopback proof; this function
 * owns credential precedence, registration scope, server-tenant binding,
 * loopback fallback, principal identity, and role tier policy.
 */
export function resolveSurfaceViewerScope(
  options: SurfaceViewerScopeResolutionOptions = {}
): SurfaceViewerScope {
  const token = options.token?.trim() || '';
  const local = options.local === true;
  const serverTenant = options.serverTenant?.trim() || undefined;
  if (serverTenant && !isValidTenantSlug(serverTenant)) {
    throw new SurfaceViewerScopeError(403, 'server tenant scope is invalid.');
  }

  const resolution = token
    ? resolveSurfaceViewerToken(token, {
        registrations: options.registrations,
        apiToken: options.apiToken,
        localadminToken: options.localadminToken,
        configuredCredentials: options.configuredCredentials,
      })
    : null;

  if (resolution) {
    const registration = resolution.registration;
    const tenantSlugs = registration
      ? registration.tenant_slugs
      : serverTenant
        ? [serverTenant]
        : local
          ? 'all'
          : undefined;
    if (!tenantSlugs && !local) {
      throw new SurfaceViewerScopeError(
        403,
        'Remote viewer access requires server-side tenant scope.'
      );
    }
    return {
      role: resolution.role,
      tenantSlugs: tenantSlugs || 'all',
      organizationIds: registration?.organization_ids ?? 'all',
      projectIds: registration?.project_ids ?? 'all',
      tierAccess: resolveSurfaceViewerScopeTierAccess(
        resolution.role,
        registration?.tier_access,
        options.allowPersonalTier !== false
      ),
      source: 'token',
      principalId: registration?.label || options.principalIds?.[resolution.role] || undefined,
    };
  }

  if (token) throw new SurfaceViewerScopeError(401, 'Unknown viewer token.');

  if (local && options.allowLoopback && options.loopbackRole) {
    return {
      role: options.loopbackRole,
      tenantSlugs: options.loopbackUsesServerTenant && serverTenant ? [serverTenant] : 'all',
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: resolveSurfaceViewerScopeTierAccess(
        options.loopbackRole,
        undefined,
        options.allowPersonalTier !== false
      ),
      source: 'loopback',
      principalId: options.principalIds?.[options.loopbackRole],
    };
  }

  throw new SurfaceViewerScopeError(401, 'A viewer principal is required.');
}

function resolveSurfaceViewerScopeTierAccess(
  role: ChronosAccessRole,
  requested: readonly OsKnowledgeTier[] | undefined,
  allowPersonalTier: boolean
): OsKnowledgeTier[] {
  if (!allowPersonalTier && requested?.includes('personal')) {
    throw new SurfaceViewerScopeError(403, `viewer tier scope exceeds the ${role} role policy.`);
  }
  const resolved = resolveSurfaceViewerTierAccess(role, requested);
  return allowPersonalTier ? resolved : resolved.filter((tier) => tier !== 'personal');
}

export function narrowSurfaceViewerTier(
  viewer: Pick<SurfaceViewerScope, 'role' | 'tierAccess'>,
  requested: OsKnowledgeTier
): OsKnowledgeTier {
  const allowed = viewer.tierAccess.length
    ? viewer.tierAccess
    : defaultSurfaceViewerTierAccess(viewer.role);
  if (!allowed.includes(requested)) {
    throw new SurfaceViewerScopeError(403, `viewer tier scope denied: ${requested}`);
  }
  return requested;
}

function narrowViewerScope(
  kind: 'tenant' | 'organization' | 'project',
  allowed: string[] | 'all',
  requested?: string | null
): string[] | 'all' {
  const value = requested?.trim() || undefined;
  const valid =
    kind === 'tenant'
      ? value === undefined || isValidTenantSlug(value)
      : value === undefined || isValidChronosScopeId(value);
  if (!valid) throw new SurfaceViewerScopeError(403, `invalid viewer ${kind} scope: ${value}`);
  if (value && allowed !== 'all' && !allowed.includes(value)) {
    throw new SurfaceViewerScopeError(403, `viewer ${kind} scope denied: ${value}`);
  }
  return value ? [value] : allowed;
}

export function narrowSurfaceViewerScope(
  viewer: Pick<SurfaceViewerScope, 'tenantSlugs' | 'organizationIds' | 'projectIds'>,
  requested: {
    tenant?: string | null;
    organizationId?: string | null;
    projectId?: string | null;
  }
) {
  return {
    tenantSlugs: narrowViewerScope('tenant', viewer.tenantSlugs, requested.tenant),
    organizationIds: narrowViewerScope(
      'organization',
      viewer.organizationIds,
      requested.organizationId
    ),
    projectIds: narrowViewerScope('project', viewer.projectIds, requested.projectId),
  };
}

export function narrowSurfaceViewerTenant(
  viewer: Pick<SurfaceViewerScope, 'tenantSlugs'>,
  requested?: string | null
): string[] | 'all' {
  return narrowViewerScope('tenant', viewer.tenantSlugs, requested);
}
