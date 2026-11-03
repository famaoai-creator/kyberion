import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Liveness probe for the surface runtime (`healthPath` in
 * knowledge/product/governance/surfaces/concierge.json). Intentionally
 * unauthenticated and data-free: a credential-less loopback probe must stay
 * healthy after anonymous loopback stops being the local operator, so this
 * says only that the process serves requests.
 */
export function GET() {
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
