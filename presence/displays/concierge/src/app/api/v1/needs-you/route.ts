import type { NextRequest } from 'next/server';
import { handleNeedsYouRequest } from '../../../../lib/needs-you-server';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/needs-you` → `{ ok, items, total, nextCursor? }` — the open
 * needs-you queue (count definition: libs/core/surface/needs-you.ts). Filters:
 * `reason`, `overdue`, `cursor`, `limit`; `tenant` / `organization_id` /
 * `project_id` only narrow the server-resolved viewer. Same operation as MCP
 * `kyberion.needs-you.list`.
 */
export function GET(req: NextRequest) {
  return handleNeedsYouRequest(req, 'needs-you.list');
}
