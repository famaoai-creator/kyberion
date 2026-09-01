import type { Request } from 'express';
import {
  resolveSurfaceViewerScope,
  SurfaceViewerScopeError,
} from '@agent/core/surface-mutation-guard';
import type { SurfaceAuthorizationContext } from '@agent/core/surface-authorization';

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
  return raw;
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
  const principalId = String(env.KYBERION_COMPUTER_SURFACE_PRINCIPAL || '');

  try {
    const scope = resolveSurfaceViewerScope({
      token,
      local,
      serverTenant: tenant,
      apiToken,
      localadminToken,
      allowLoopback: env.KYBERION_LOCALHOST_AUTOADMIN !== 'false',
      loopbackRole: 'localadmin',
      loopbackUsesServerTenant: true,
      principalIds: {
        localadmin: principalId.startsWith('human:')
          ? principalId
          : 'human:computer-surface-localadmin',
        readonly: 'human:computer-surface-viewer',
      },
    });
    // Preserve Computer Surface's existing wire order while the shared core
    // resolver remains the sole authority for the allowed tier set.
    const tierOrder = ['personal', 'confidential', 'public'] as const;
    return {
      ...scope,
      tierAccess: tierOrder.filter((tier) => scope.tierAccess.includes(tier)),
    };
  } catch (error) {
    if (!(error instanceof SurfaceViewerScopeError)) throw error;
    if (error.status === 401 && error.message === 'Unknown viewer token.') {
      throw new ComputerSurfaceViewerError(401, 'Unknown Computer Surface viewer token.');
    }
    if (error.status === 403 && error.message.includes('Remote viewer access requires')) {
      throw new ComputerSurfaceViewerError(
        403,
        'Remote Computer Surface access requires server-side KYBERION_TENANT scope.'
      );
    }
    if (error.status === 403 && error.message === 'server tenant scope is invalid.') {
      throw new ComputerSurfaceViewerError(403, 'Computer Surface server tenant scope is invalid.');
    }
    throw new ComputerSurfaceViewerError(error.status, error.message);
  }
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
