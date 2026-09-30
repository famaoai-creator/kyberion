import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import * as secureIo from '@agent/core/secure-io';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { actOnCharter } from '../../../../lib/charter-server';
import { readRequestObject } from '../../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

/**
 * The accountable human's off switch: `stop` (raise the manual-stop tripwire —
 * every charter-covered action is blocked), `clear` (resume) and `retire`
 * (drop the charter; the scope returns to per-action approval). Only the
 * accountable human or a named deputy may do any of them.
 */
export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const parsedBody = await readRequestObject(req, 'request body', ['tenant_slug', 'action']);
    if (!parsedBody.ok) {
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    }
    const { body } = parsedBody;
    const action = body?.action;
    if (action !== 'stop' && action !== 'clear' && action !== 'retire') {
      return NextResponse.json(
        { ok: false, error: 'action must be stop, clear or retire' },
        { status: 400 }
      );
    }
    const result = withExecutionContext('sovereign_concierge', () =>
      secureIo.withSensitivePathMediation(() =>
        actOnCharter(resolved.context, body?.tenant_slug, action)
      )
    );
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
