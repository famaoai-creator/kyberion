import { NextRequest, NextResponse } from 'next/server';
import { frontDeskRoleFromViewer } from '@agent/core/front-desk-nav';
import {
  buildFrontDeskNavPayload,
  resolveFrontDeskNavLocale,
} from '../../../../lib/front-desk-nav';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';

/**
 * FD-00c: `GET /api/front-desk/nav` — renders the shared front-desk rail
 * definition (`@agent/core/front-desk-nav`) for the concierge surface. Same
 * response shape as the presence-studio sibling route (plan §2.1/§3 FD-00).
 * Requires a resolved viewer (same guard as `/api/me`) because the item list
 * is role-gated (`allowed`), and ports are always read from the surface
 * manifest — never hardcoded.
 */
export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const locale = resolveFrontDeskNavLocale(req.nextUrl.searchParams.get('locale'));
    const role = frontDeskRoleFromViewer({ role: resolved.context.role });
    const payload = buildFrontDeskNavPayload({ locale, role });
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
