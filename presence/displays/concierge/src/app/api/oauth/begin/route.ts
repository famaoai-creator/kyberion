import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { beginInteractiveServiceOAuth } from '@agent/core/oauth-broker';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { readRequestObject } from '../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

/** Concierge catalog ids that differ from service-preset / oauth-broker ids. */
const SERVICE_ID_ALIASES: Record<string, string> = {
  'microsoft-365': 'm365',
};

function resolveOAuthServiceId(raw: string): string {
  const trimmed = raw.trim();
  return SERVICE_ID_ALIASES[trimmed] || trimmed;
}

function ensureOAuthCallbackSurface(): void {
  // Best-effort: start callback receiver; if already bound the child exits quickly.
  spawn('node', ['--import', './scripts/ts-loader.mjs', 'scripts/oauth_callback_surface.ts'], {
    cwd: pathResolver.rootDir(),
    env: { ...process.env, KYBERION_PERSONA: 'sovereign' },
    detached: true,
    stdio: 'ignore',
  }).unref();
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

    ensureOAuthCallbackSurface();
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
