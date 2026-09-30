import type { NextRequest } from 'next/server';
import { handleOperatorAuthRoute } from '@/lib/surface-auth-route';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  return handleOperatorAuthRoute(req);
}
