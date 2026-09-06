import { NextRequest, NextResponse } from 'next/server';
import { parseConciergeLimit, readConciergeHome } from '../../../lib/headless-projections';
import { readConciergeScopeQuery } from '../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const summary = readConciergeHome(resolved.context, {
      ...readConciergeScopeQuery(req.nextUrl.searchParams),
      limit: parseConciergeLimit(req.nextUrl.searchParams.get('limit')),
    });
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    return conciergeErrorResponse(error);
  }
}
