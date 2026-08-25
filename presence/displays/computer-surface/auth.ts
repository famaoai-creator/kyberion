import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { isValidTenantSlug, type SurfaceAuthorizationContext } from '@agent/core';

type ComputerSurfaceRequest = Pick<Request, 'headers' | 'socket'>;

export class ComputerSurfaceViewerError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string
  ) {
    super(message);
    this.name = 'ComputerSurfaceViewerError';
  }
}

function tokenMatches(candidate: string, configured: string | undefined): boolean {
  if (!candidate || !configured) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(configured);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(req: ComputerSurfaceRequest): string {
  const value = req.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

export function isComputerSurfaceLoopbackRequest(req: ComputerSurfaceRequest): boolean {
  const remote = req.socket.remoteAddress || '';
  const forwarded = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim();
  const loopbackAddresses = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  return (
    loopbackAddresses.includes(remote) && (!forwarded || loopbackAddresses.includes(forwarded))
  );
}

function serverTenant(env: NodeJS.ProcessEnv): string | undefined {
  const raw = String(env.KYBERION_TENANT || '').trim();
  if (!raw) return undefined;
  if (!isValidTenantSlug(raw)) {
    throw new ComputerSurfaceViewerError(403, 'Computer Surface server tenant scope is invalid.');
  }
  return raw;
}

function defaultTierAccess(role: 'readonly' | 'localadmin'): string[] {
  return role === 'localadmin'
    ? ['personal', 'confidential', 'public']
    : ['confidential', 'public'];
}

function contextFor(
  role: 'readonly' | 'localadmin',
  source: 'token' | 'loopback',
  tenant: string | undefined,
  principalId: string
): SurfaceAuthorizationContext {
  return {
    role,
    tenantSlugs: tenant ? [tenant] : 'all',
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: defaultTierAccess(role),
    principalId,
    source,
  };
}

/**
 * Resolve Computer Surface authority from the request and server environment.
 * A client cannot choose the role or tenant scope. Remote bearer access is
 * always bound to KYBERION_TENANT; loopback is the localadmin convenience
 * boundary unless explicitly disabled.
 */
export function resolveComputerSurfaceViewerContext(
  req: ComputerSurfaceRequest,
  env: NodeJS.ProcessEnv = process.env
): SurfaceAuthorizationContext {
  const token = bearerToken(req);
  const localadminToken = env.KYBERION_LOCALADMIN_TOKEN;
  const apiToken = env.KYBERION_API_TOKEN;
  const local = isComputerSurfaceLoopbackRequest(req);
  const tenant = serverTenant(env);

  if (token) {
    const role = tokenMatches(token, localadminToken)
      ? 'localadmin'
      : tokenMatches(token, apiToken)
        ? 'readonly'
        : null;
    if (!role) throw new ComputerSurfaceViewerError(401, 'Unknown Computer Surface viewer token.');
    if (!local && !tenant) {
      throw new ComputerSurfaceViewerError(
        403,
        'Remote Computer Surface access requires server-side KYBERION_TENANT scope.'
      );
    }
    return contextFor(
      role,
      'token',
      tenant,
      role === 'localadmin' ? 'human:computer-surface-localadmin' : 'human:computer-surface-viewer'
    );
  }

  if (local && env.KYBERION_LOCALHOST_AUTOADMIN !== 'false') {
    return contextFor(
      'localadmin',
      'loopback',
      tenant,
      String(env.KYBERION_COMPUTER_SURFACE_PRINCIPAL || '').startsWith('human:')
        ? String(env.KYBERION_COMPUTER_SURFACE_PRINCIPAL)
        : 'human:computer-surface-localadmin'
    );
  }

  throw new ComputerSurfaceViewerError(401, 'A Computer Surface viewer principal is required.');
}

export function computerSurfaceServerTenantResource(context: SurfaceAuthorizationContext): {
  tenantSlug?: string;
} {
  return context.tenantSlugs !== 'all' && context.tenantSlugs.length === 1
    ? { tenantSlug: context.tenantSlugs[0] }
    : {};
}

function collectTenantSlugs(value: unknown, result: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectTenantSlugs(item, result);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  for (const key of ['tenant_slug', 'tenantSlug']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) result.add(candidate.trim());
  }
  for (const nested of Object.values(record)) collectTenantSlugs(nested, result);
}

/** Reject A2UI payloads that explicitly widen the server-resolved tenant. */
export function assertComputerSurfacePayloadInScope(
  context: SurfaceAuthorizationContext,
  payload: unknown
): void {
  if (context.tenantSlugs === 'all') return;
  const tenants = new Set<string>();
  collectTenantSlugs(payload, tenants);
  const denied = [...tenants].find((tenant) => !context.tenantSlugs.includes(tenant));
  if (denied) {
    throw new ComputerSurfaceViewerError(403, `Computer Surface tenant scope denied: ${denied}`);
  }
}
