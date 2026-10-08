import { NextRequest, NextResponse } from 'next/server';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { startIdentityLinkForViewer } from '../../../../lib/first-run-server';
import { isLoopbackPeer } from '../../../../lib/loopback-peer';
import { resolveConciergeViewer } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const LINKED_NEXT = '/setup/sso?linked=1';

/**
 * Start "link my IdP account": returns the IdP authorize URL and sets the
 * sealed transaction cookie that carries the viewer's member id.
 */
export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const viewer = resolveConciergeViewer(req);
  if (viewer.response) return viewer.response;
  const result = await startIdentityLinkForViewer(viewer.context, {
    requestOrigin: new URL(req.url).origin,
    loopback: isLoopbackPeer(req),
    next: LINKED_NEXT,
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.status, headers: NO_STORE }
    );
  }
  const response = NextResponse.json(
    { ok: true, location: result.location },
    { headers: NO_STORE }
  );
  for (const cookie of result.setCookies) response.headers.append('Set-Cookie', cookie);
  return response;
}
