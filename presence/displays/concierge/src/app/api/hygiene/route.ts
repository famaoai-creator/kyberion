import { NextRequest, NextResponse } from 'next/server';
import { listHygieneInquiries } from '../../../lib/hygiene-server';
import { resolveConciergeSelectedViewer } from '../../../lib/selected-tenant';
import { conciergeErrorResponse } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

/**
 * CS-03 停滞ミッション伺いカード — read-only list of planned missions that
 * never started (mission hygiene findings), mapped to user-facing entries.
 * Reason codes are translated to plain language client-side; internal
 * remediation commands never leave the server. Deciding start/cancel is a
 * separate, guarded POST (api/hygiene/[id]) fired only by an explicit click.
 */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) return resolved.response;
  try {
    return NextResponse.json({ ok: true, inquiries: listHygieneInquiries(resolved.context) });
  } catch (error) {
    return conciergeErrorResponse(error);
  }
}
