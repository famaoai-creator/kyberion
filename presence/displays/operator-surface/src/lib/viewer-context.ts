import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { SurfaceViewerScopeError } from '@agent/core/surface/surface-mutation-guard';
import { resolveAuthnSurfaceViewerScope } from '@agent/core/surface/surface-authn';
import {
  SURFACE_SESSION_COOKIE,
  extractSurfaceCredential,
  isSameOriginMutation,
  type SurfaceCredentialSource,
} from '@agent/core/surface/surface-session-cookie';
import { LOOPBACK_HEADER } from './peer';

export interface OperatorViewer {
  role: string;
  principalId?: string;
  source: string;
  loopback: boolean;
  credentialSource: SurfaceCredentialSource;
}

interface HeaderLookup {
  get(name: string): string | null;
}

/**
 * Resolve the operator viewer. Loopback (decided by the caller from the real
 * socket peer / middleware marker) without a credential is the existing
 * local-operator read viewer; a presented credential always outranks it.
 * Throws SurfaceViewerScopeError (401/403) when no viewer can be proven.
 */
export function resolveOperatorViewer(input: {
  authorization?: string | null;
  cookie?: string | null;
  loopback: boolean;
}): OperatorViewer {
  const { token, source } = extractSurfaceCredential({
    authorization: input.authorization,
    cookie: input.cookie,
  });
  const { scope } = resolveAuthnSurfaceViewerScope({
    token,
    local: input.loopback,
    serverTenant: (getRegisteredEnvText('KYBERION_TENANT') || '').trim(),
    allowLoopback: true,
    loopbackRole: 'readonly',
    allowPersonalTier: false,
    surface: 'operator-surface',
  });
  return {
    role: scope.role,
    principalId: scope.principalId,
    source: scope.source,
    loopback: input.loopback,
    credentialSource: source,
  };
}

/**
 * Server-verified gate for pages (root layout). Loopback is read from the
 * middleware-owned marker header; any failure sends the browser to /login.
 */
export async function requireOperatorViewer(): Promise<OperatorViewer> {
  const h = await headers();
  const jar = await cookies();
  const session = jar.get(SURFACE_SESSION_COOKIE)?.value;
  try {
    return resolveOperatorViewer({
      authorization: h.get('authorization'),
      cookie: session ? `${SURFACE_SESSION_COOKIE}=${session}` : null,
      loopback: h.get(LOOPBACK_HEADER) === '1',
    });
  } catch (error) {
    if (!(error instanceof SurfaceViewerScopeError)) throw error;
    redirect('/login');
  }
}

/** API guard: null when a viewer is resolved, else a 401/403 JSON response. */
export function requireOperatorViewerAccess(req: {
  method: string;
  headers: HeaderLookup;
  loopback: boolean;
}): NextResponse | null {
  let viewer: OperatorViewer;
  try {
    viewer = resolveOperatorViewer({
      authorization: req.headers.get('authorization'),
      cookie: req.headers.get('cookie'),
      loopback: req.loopback,
    });
  } catch (error) {
    if (!(error instanceof SurfaceViewerScopeError)) throw error;
    return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
  }
  if (
    viewer.credentialSource === 'session-cookie' &&
    !isSameOriginMutation({
      method: req.method,
      headers: req.headers,
      expectedHost: req.headers.get('host') || '',
    })
  ) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request denied.' }, { status: 403 });
  }
  return null;
}
