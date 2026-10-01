import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import * as secureIo from '@agent/core/secure-io';
import { requireConciergeJoinAccess } from '../../../../lib/api-guard';
import { acceptInviteForViewer, previewInviteForViewer } from '../../../../lib/invite-server';
import { readRequestObject } from '../../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

const asContext = <T>(fn: () => T): T =>
  withExecutionContext('sovereign_concierge', () => secureIo.withSensitivePathMediation(fn));

/** "Confirm your role": what the code grants. Needs a verified identity; a code alone reveals nothing. */
export function GET(req: NextRequest) {
  const denied = requireConciergeJoinAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const result = asContext(() =>
      previewInviteForViewer(resolved.context, req.nextUrl.searchParams.get('code'))
    );
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

/** Join. The identity that joins is the server-verified one; only the code and a display name come from the client. */
export async function POST(req: NextRequest) {
  const denied = requireConciergeJoinAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const parsedBody = await readRequestObject(req, 'request body', ['code', 'display_name']);
    if (!parsedBody.ok) {
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    }
    const result = asContext(() => acceptInviteForViewer(resolved.context, parsedBody.body ?? {}));
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
