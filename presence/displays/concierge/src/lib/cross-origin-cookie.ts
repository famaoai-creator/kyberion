import { NextResponse, type NextRequest } from 'next/server';
import {
  isSameOriginMutation,
  type SurfaceCredentialSource,
} from '@agent/core/surface/surface-session-cookie';
import { conciergeCredential } from './viewer-context';

/**
 * The one cross-origin check for cookie-borne requests, shared by the
 * Concierge mutation / join gates and the operations gates. A cookie rides
 * along on cross-site requests, so a cookie-borne unsafe request must be
 * same-origin (`isSameOriginMutation` passes GET / HEAD / OPTIONS). A
 * header credential is not cookie-borne and skips the check.
 * Returns the 403 response, or null when the request may proceed.
 */
export function crossOriginCookieMutation(
  req: NextRequest,
  credential: { source: SurfaceCredentialSource } = conciergeCredential(req)
): NextResponse | null {
  if (credential.source !== 'session-cookie') return null;
  if (
    isSameOriginMutation({
      method: req.method,
      headers: req.headers,
      expectedHost: req.headers.get('host') ?? new URL(req.url).host,
    })
  ) {
    return null;
  }
  return NextResponse.json(
    { ok: false, error: 'Forbidden. Cross-origin session request.' },
    { status: 403 }
  );
}
