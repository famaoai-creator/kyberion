import type { NextRequest } from 'next/server';
import { handleConciergeAuthRoute } from '../../lib/surface-auth-route';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest): Promise<Response> {
  return handleConciergeAuthRoute(req);
}

export function POST(req: NextRequest): Promise<Response> {
  return handleConciergeAuthRoute(req);
}
