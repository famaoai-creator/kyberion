import type { NextRequest } from 'next/server';
import { handleNeedsYouRequest } from '../../../../../lib/needs-you-server';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/needs-you/summary` → `{ ok, total, overdue, oldestWaitingSince?,
 * byReason }` — the only needs-you count any surface shows. Same operation as
 * MCP `kyberion.needs-you.summary`.
 */
export function GET(req: NextRequest) {
  return handleNeedsYouRequest(req, 'needs-you.summary');
}
