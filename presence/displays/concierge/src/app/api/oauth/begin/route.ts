import { NextRequest, NextResponse } from 'next/server';
import { beginInteractiveServiceOAuth } from '@agent/core/oauth-broker';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult, safeExistsSync } from '@agent/core/secure-io';
import { loadSurfaceManifest, probeSurfaceHealth } from '@agent/core/surface-runtime';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { readRequestObject } from '../../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

/** Concierge catalog ids that differ from service-preset / oauth-broker ids. */
const SERVICE_ID_ALIASES: Record<string, string> = {
  'microsoft-365': 'm365',
};

function resolveOAuthServiceId(raw: string): string {
  const trimmed = raw.trim();
  return SERVICE_ID_ALIASES[trimmed] || trimmed;
}

const OAUTH_CALLBACK_SURFACE_ID = 'oauth-callback-surface';
const SURFACE_RUNTIME_RELATIVE = 'dist/scripts/surface_runtime.js';
const SURFACE_START_TIMEOUT_MS = 15_000;

/**
 * Best-effort: make sure the registered OAuth callback receiver (:8787) is
 * up before handing the browser an authorization URL. The receiver is a
 * governed surface (`knowledge/product/governance/surfaces/oauth-callback-surface.json`),
 * so it is started through the surface runtime CLI — never by spawning the
 * script directly from this route (process boundary contract). A `detached`
 * surface returns control to the CLI as soon as it is launched.
 */
async function ensureOAuthCallbackSurface(): Promise<void> {
  try {
    const definition = loadSurfaceManifest().surfaces.find(
      (surface) => surface.id === OAUTH_CALLBACK_SURFACE_ID
    );
    if (!definition) return;
    const health = await probeSurfaceHealth(definition);
    if (health.status === 'healthy') return;

    const rootDir = pathResolver.rootDir();
    const runtimePath = `${rootDir}/${SURFACE_RUNTIME_RELATIVE}`;
    if (!safeExistsSync(runtimePath)) {
      console.error(`[concierge/oauth] surface runtime build missing: ${runtimePath}`);
      return;
    }
    const result = safeExecResult(
      process.execPath,
      [SURFACE_RUNTIME_RELATIVE, 'start', '--surface', OAUTH_CALLBACK_SURFACE_ID],
      { cwd: rootDir, timeoutMs: SURFACE_START_TIMEOUT_MS, maxOutputMB: 1 }
    );
    if (result.status !== 0) {
      console.error(
        `[concierge/oauth] surface runtime start ${OAUTH_CALLBACK_SURFACE_ID} exit=${result.status}\n${result.stderr}`
      );
    }
  } catch (error) {
    console.error('[concierge/oauth] could not ensure the OAuth callback surface', error);
  }
}

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;

  try {
    const parsedBody = await readRequestObject(req, 'request body', ['service_id']);
    if (!parsedBody.ok) {
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    }
    const serviceRaw = String(parsedBody.body.service_id || '').trim();
    if (!serviceRaw) {
      return NextResponse.json({ ok: false, error: 'service_id is required' }, { status: 400 });
    }
    const serviceId = resolveOAuthServiceId(serviceRaw);
    const callbackHost = getRegisteredEnvText('KYBERION_OAUTH_CALLBACK_HOST') || '127.0.0.1';
    const callbackPort = Number(getRegisteredEnvText('KYBERION_OAUTH_CALLBACK_PORT') || 8787);
    const callbackPath = getRegisteredEnvText('KYBERION_OAUTH_CALLBACK_PATH') || '/oauth/callback';
    const redirectUri = `http://${callbackHost}:${callbackPort}${callbackPath}`;

    await ensureOAuthCallbackSurface();
    const session = beginInteractiveServiceOAuth(serviceId, { redirectUri });
    return NextResponse.json({
      ok: true,
      service_id: serviceId,
      catalog_id: serviceRaw,
      authorization_url: session.authorizationUrl,
      redirect_uri: redirectUri,
      state: session.state,
    });
  } catch (error) {
    return conciergeErrorResponse(error);
  }
}
