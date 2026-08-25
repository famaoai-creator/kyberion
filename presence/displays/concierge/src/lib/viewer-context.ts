import { NextResponse, type NextRequest } from 'next/server';
import {
  findChronosTokenRegistration,
  currentScope,
  matchesChronosToken,
  readChronosTokenRegistrations,
  defaultSurfaceViewerTierAccess,
  narrowSurfaceViewerScope,
  resolveSurfaceViewerTierAccess,
  extractSurfaceBearerToken,
  type ChronosAccessRole,
  type ChronosTokenRegistration,
} from '@agent/core';
import { withExecutionContext } from '@agent/core/authority';
import { getRegisteredEnvText } from '@agent/core/foundation';
import type { HeadlessViewerScope } from '@agent/core/headless-surface-contract';

export interface ConciergeViewerContext {
  role: ChronosAccessRole;
  tenantSlugs: string[] | 'all';
  organizationIds: string[] | 'all';
  projectIds: string[] | 'all';
  tierAccess: Array<'personal' | 'confidential' | 'public'>;
  source: 'token' | 'loopback';
  principalId?: string;
}

export class ConciergeViewerError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string
  ) {
    super(message);
    this.name = 'ConciergeViewerError';
  }
}

function isLoopbackRequest(req: NextRequest): boolean {
  const hostname = req.nextUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const loopbackHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (!loopbackHost) return false;
  return (
    !forwarded ||
    forwarded === '127.0.0.1' ||
    forwarded === '::1' ||
    forwarded === '::ffff:127.0.0.1'
  );
}

function bearerToken(req: NextRequest): string | null {
  return extractSurfaceBearerToken(req.headers.get('authorization')) || null;
}

function registrations(): ChronosTokenRegistration[] | null {
  try {
    return readChronosTokenRegistrations();
  } catch {
    throw new ConciergeViewerError(401, 'Concierge viewer token registry is unavailable.');
  }
}

function registeredViewer(token: string): ChronosTokenRegistration | null {
  const registry = registrations();
  return registry ? findChronosTokenRegistration(token, registry) : null;
}

function defaultTierAccess(role: ChronosAccessRole): ConciergeViewerContext['tierAccess'] {
  return defaultSurfaceViewerTierAccess(role);
}

function serverTenant(): string {
  try {
    return String(currentScope({}, { ...process.env }).tenant_slug || '').trim();
  } catch {
    return '';
  }
}

function resolveTierAccess(
  role: ChronosAccessRole,
  requested?: readonly ConciergeViewerContext['tierAccess'][number][]
): ConciergeViewerContext['tierAccess'] {
  try {
    return resolveSurfaceViewerTierAccess(role, requested);
  } catch (error) {
    throw new ConciergeViewerError(
      403,
      error instanceof Error
        ? `Concierge ${error.message}`
        : `Concierge viewer tier scope exceeds the ${role} role policy.`
    );
  }
}

export function resolveConciergeViewerContext(req: NextRequest): ConciergeViewerContext {
  const local = isLoopbackRequest(req);
  const token = bearerToken(req);
  const registration = token ? registeredViewer(token) : null;
  const apiToken = getRegisteredEnvText('KYBERION_API_TOKEN');
  const localadminToken = getRegisteredEnvText('KYBERION_LOCALADMIN_TOKEN');

  if (registration) {
    return {
      role: registration.role,
      tenantSlugs: registration.tenant_slugs,
      organizationIds: registration.organization_ids || 'all',
      projectIds: registration.project_ids || 'all',
      tierAccess: resolveTierAccess(registration.role, registration.tier_access),
      source: 'token',
      principalId: registration.label,
    };
  }

  if (
    token &&
    (matchesChronosToken(token, apiToken) || matchesChronosToken(token, localadminToken))
  ) {
    const role: ChronosAccessRole = matchesChronosToken(token, localadminToken)
      ? 'localadmin'
      : 'readonly';
    const tenant = serverTenant();
    if (!local && !tenant) {
      throw new ConciergeViewerError(
        403,
        'Remote Concierge access requires server-side KYBERION_TENANT scope.'
      );
    }
    return {
      role,
      tenantSlugs: tenant ? [tenant] : 'all',
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: defaultTierAccess(role),
      source: 'token',
      principalId: role === 'localadmin' ? 'human:concierge-localadmin' : 'human:concierge-token',
    };
  }

  if (token) throw new ConciergeViewerError(401, 'Unknown Concierge viewer token.');
  if (!local) throw new ConciergeViewerError(401, 'A Concierge viewer principal is required.');

  const tenant = serverTenant();
  return {
    role: 'localadmin',
    tenantSlugs: tenant ? [tenant] : 'all',
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: defaultTierAccess('localadmin'),
    source: 'loopback',
    principalId: 'human:concierge-localadmin',
  };
}

export function resolveConciergeViewer(
  req: NextRequest
):
  | { context: ConciergeViewerContext; response?: never }
  | { context?: never; response: NextResponse } {
  try {
    return { context: resolveConciergeViewerContext(req) };
  } catch (error) {
    return {
      response: NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : 'Unauthorized' },
        { status: error instanceof ConciergeViewerError ? error.status : 401 }
      ),
    };
  }
}

export function narrowConciergeScope(
  viewer: ConciergeViewerContext,
  query: { tenant?: string | null; organizationId?: string | null; projectId?: string | null }
) {
  try {
    return narrowSurfaceViewerScope(viewer, query);
  } catch (error) {
    throw new ConciergeViewerError(
      403,
      error instanceof Error ? `Concierge ${error.message}` : 'Concierge viewer scope denied'
    );
  }
}

export function conciergeHeadlessScope(viewer: ConciergeViewerContext): HeadlessViewerScope {
  return {
    role: viewer.role,
    ...(viewer.principalId ? { principal_id: viewer.principalId } : {}),
    tenant_slugs: viewer.tenantSlugs,
    organization_ids: viewer.organizationIds,
    project_ids: viewer.projectIds,
    tier_access: viewer.tierAccess,
  };
}

export function withConciergeViewerContext<T>(viewer: ConciergeViewerContext, fn: () => T): T {
  const tenant =
    viewer.tenantSlugs !== 'all' && viewer.tenantSlugs.length === 1
      ? viewer.tenantSlugs[0]
      : undefined;
  return withExecutionContext(
    viewer.role === 'localadmin' ? 'concierge_localadmin' : 'concierge_operator',
    fn,
    undefined,
    tenant
  );
}

export function conciergeErrorResponse(error: unknown, statusOverride?: number): NextResponse {
  return NextResponse.json(
    { ok: false, error: error instanceof Error ? error.message : 'Request failed' },
    { status: statusOverride || (error instanceof ConciergeViewerError ? error.status : 500) }
  );
}
