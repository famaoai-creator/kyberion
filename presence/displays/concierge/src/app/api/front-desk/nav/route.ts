import { NextRequest, NextResponse } from 'next/server';
import {
  buildFrontDeskNavPayload,
  resolveFrontDeskNavLocale,
} from '../../../../lib/front-desk-nav';
import { resolveConciergeFrontDeskRole } from '../../../../lib/front-desk-member';
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
    // Membership-aware role (B1): a mapped member's viewed-tenant role gates
    // nav items — the flat viewer role alone would show owner menus to an
    // operator whose memberships happen to be localadmin-class elsewhere.
    const role = resolveConciergeFrontDeskRole(resolved.context);
    const payload = buildFrontDeskNavPayload({ locale, role });
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
