import { NextResponse } from 'next/server';

/**
 * Liveness probe (OP-04 Task 2). Intentionally unauthenticated and minimal:
 * a 200 here means the Next.js process serves requests — nothing more.
 * Operational detail lives behind the authenticated /api/status route.
 */
export async function GET() {
  return NextResponse.json({ ok: true, uptime_seconds: Math.round(process.uptime()) });
}
