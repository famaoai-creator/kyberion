import { NextRequest, NextResponse } from 'next/server';
import { parseConciergeLimit, readConciergeHome } from '../../../lib/headless-projections';
import { readSelectedScopeQuery } from '../../../lib/request-input';
import { resolveConciergeSelectedViewer } from '../../../lib/selected-tenant';
import { conciergeErrorResponse } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const summary = readConciergeHome(resolved.context, {
      ...readSelectedScopeQuery(req.nextUrl.searchParams),
      limit: parseConciergeLimit(req.nextUrl.searchParams.get('limit')),
    });
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    return conciergeErrorResponse(error);
  }
}
