import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { auditChain } from '@agent/core/audit-chain';
import { pathResolver, safeExistsSync } from '@agent/core';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { secretGuard } from '@agent/core/secret-guard';
import {
  isChronosLoopbackRequest,
  matchesChronosToken,
  resolveChronosAccessRole,
  resolveChronosToken,
  resolveChronosTokenRegistration,
  type ChronosAccessRole,
  type ChronosTokenRegistration,
} from './api-guard';

export interface ViewerContext {
  role: ChronosAccessRole;
  tenantSlugs: string[] | 'all';
  source: 'token' | 'loopback' | 'anonymous';
  principalId?: string;
}

export class ViewerContextError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string
  ) {
    super(message);
    this.name = 'ViewerContextError';
  }
}

function registryPath(): string {
  return pathResolver.knowledge('personal/connections/chronos-access.json');
}

function loadRegistry(): ChronosTokenRegistration[] | null {
  if (!safeExistsSync(registryPath())) return null;
  try {
    const document = secretGuard.loadConnectionDocument('chronos-access');
    if (!document || !Array.isArray(document.tokens)) {
      throw new Error('chronos access registry must contain tokens');
    }
    return document.tokens.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object') throw new Error('invalid chronos access entry');
      const value = entry as Record<string, unknown>;
      if (
        typeof value.token_hash !== 'string' ||
        (value.role !== 'readonly' && value.role !== 'localadmin') ||
        !Array.isArray(value.tenant_slugs) ||
        !value.tenant_slugs.every((tenant) => typeof tenant === 'string' && tenant.trim())
      ) {
        throw new Error('invalid chronos access entry');
      }
      return {
        token_hash: value.token_hash,
        role: value.role,
        tenant_slugs: value.tenant_slugs.map((tenant) => String(tenant).trim()),
        ...(typeof value.label === 'string' ? { label: value.label } : {}),
      } as ChronosTokenRegistration;
    });
  } catch {
    throw new ViewerContextError(401, 'Chronos viewer token registry is unavailable.');
  }
}

function resolveRegisteredEntry(token: string): ChronosTokenRegistration | null {
  const registry = loadRegistry();
  if (!registry) return resolveChronosTokenRegistration(token);
  const digest = createHash('sha256').update(token).digest('hex');
  return registry.find((entry) => matchesChronosToken(digest, entry.token_hash)) || null;
}

export function resolveViewerContext(req: NextRequest): ViewerContext {
  const token = resolveChronosToken(req);
  if (token) {
    const registration = resolveRegisteredEntry(token);
    if (registration) {
      return {
        role: registration.role,
        tenantSlugs: registration.tenant_slugs,
        source: 'token',
        principalId: registration.label,
      };
    }
    const role = resolveChronosAccessRole(req);
    if (role) {
      return { role, tenantSlugs: 'all', source: 'token' };
    }
    throw new ViewerContextError(401, 'Unknown Chronos viewer token.');
  }

  const role = resolveChronosAccessRole(req);
  if (role && isChronosLoopbackRequest(req)) {
    return { role, tenantSlugs: 'all', source: 'loopback' };
  }
  throw new ViewerContextError(401, 'A Chronos viewer principal is required.');
}

export function resolveViewerContextForRequest(
  req: NextRequest
): { context: ViewerContext; response?: never } | { context?: never; response: NextResponse } {
  try {
    return { context: resolveViewerContext(req) };
  } catch (error) {
    const status = error instanceof ViewerContextError ? error.status : 401;
    return {
      response: NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : 'Unauthorized' },
        { status }
      ),
    };
  }
}

export function authorizeViewerTenant(
  viewer: ViewerContext,
  requestedTenant: string | null | undefined
): string | undefined {
  const requested = requestedTenant?.trim() || undefined;
  if (!requested || viewer.tenantSlugs === 'all') return requested;
  if (viewer.tenantSlugs.includes(requested)) return requested;

  const mode = process.env.KYBERION_VIEWER_SCOPE || 'warn';
  const reason = `viewer tenant scope denied: ${requested}`;
  if (mode === 'enforce') throw new ViewerContextError(403, reason);
  if (mode === 'warn') {
    try {
      auditChain.record({
        agentId: viewer.principalId || 'chronos-viewer',
        action: 'viewer_scope',
        operation: 'tenant_read',
        result: 'denied',
        reason,
        metadata: { mode, tenant: requested, role: viewer.role },
      });
    } catch {
      // Observability must not turn warn-mode compatibility into a 500.
    }
  }
  return requested;
}

export function viewerScopeTenantSlugs(
  viewer: ViewerContext,
  requested?: string
): string[] | 'all' {
  const selected = authorizeViewerTenant(viewer, requested);
  if (selected) return [selected];
  return viewer.tenantSlugs;
}

/** Propagate the request-derived tenant into tier-guard identity resolution. */
export function withViewerExecutionContext<T>(viewer: ViewerContext, fn: () => T): T {
  const role = viewer.role === 'localadmin' ? 'chronos_localadmin' : 'chronos_operator';
  const tenant =
    viewer.tenantSlugs !== 'all' && viewer.tenantSlugs.length === 1
      ? viewer.tenantSlugs[0]
      : undefined;
  return withExecutionContext(role, fn, undefined, tenant);
}

export async function withViewerExecutionContextAsync<T>(
  viewer: ViewerContext,
  fn: () => Promise<T> | T
): Promise<T> {
  const role = viewer.role === 'localadmin' ? 'chronos_localadmin' : 'chronos_operator';
  const tenant =
    viewer.tenantSlugs !== 'all' && viewer.tenantSlugs.length === 1
      ? viewer.tenantSlugs[0]
      : undefined;
  return withExecutionContextAsync(role, fn, undefined, tenant);
}

export function viewerErrorResponse(error: unknown): NextResponse {
  const status = error instanceof ViewerContextError ? error.status : 403;
  return NextResponse.json(
    { ok: false, error: error instanceof Error ? error.message : 'Forbidden' },
    { status }
  );
}
