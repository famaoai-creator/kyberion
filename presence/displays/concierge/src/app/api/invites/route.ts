import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import * as secureIo from '@agent/core/secure-io';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import {
  createInviteForViewer,
  readInviteOverview,
  revokeInviteForViewer,
} from '../../../lib/invite-server';
import { readRequestObject } from '../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

const asContext = <T>(fn: () => T): T =>
  withExecutionContext('sovereign_concierge', () => secureIo.withSensitivePathMediation(fn));

/** Invites of the tenants where the viewer is an owner or approver. Never returns a code or its hash. */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const overview = asContext(() => readInviteOverview(resolved.context));
    return NextResponse.json(
      { ok: true, ...overview },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

/** `create` (the code is returned exactly once) or `revoke`. The inviter is the authenticated member. */
export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const parsedBody = await readRequestObject(req, 'request body', [
      'action',
      'tenant_slug',
      'role',
      'ttl_hours',
      'invite_id',
    ]);
    if (!parsedBody.ok) {
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    }
    const { body } = parsedBody;
    const action = body?.action;
    if (action !== 'create' && action !== 'revoke') {
      return NextResponse.json(
        { ok: false, error: 'action must be create or revoke' },
        { status: 400 }
      );
    }
    const result = asContext(() =>
      action === 'create'
        ? createInviteForViewer(resolved.context, body ?? {})
        : revokeInviteForViewer(resolved.context, body ?? {})
    );
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
