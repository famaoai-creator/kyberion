import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import * as secureIo from '@agent/core/secure-io';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { readPushStatus, subscribePush, unsubscribePush } from '../../../lib/push-server';
import { readRequestObject } from '../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

const asContext = <T>(fn: () => T): T =>
  withExecutionContext('sovereign_concierge', () => secureIo.withSensitivePathMediation(fn));

/** Whether push is set up on this server, and how many of the viewer's devices are subscribed. */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const status = asContext(() => readPushStatus(resolved.context));
    return NextResponse.json({ ok: true, ...status }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

/** `subscribe` (a browser PushSubscription) or `unsubscribe` (its endpoint). The device is always the viewer's own. */
export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const parsedBody = await readRequestObject(req, 'request body', [
      'action',
      'subscription',
      'endpoint',
    ]);
    if (!parsedBody.ok) {
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    }
    const { body } = parsedBody;
    const action = body?.action;
    if (action !== 'subscribe' && action !== 'unsubscribe') {
      return NextResponse.json(
        { ok: false, error: 'action must be subscribe or unsubscribe' },
        { status: 400 }
      );
    }
    const result = asContext(() =>
      action === 'subscribe'
        ? subscribePush(resolved.context, body?.subscription)
        : unsubscribePush(resolved.context, body?.endpoint)
    );
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
