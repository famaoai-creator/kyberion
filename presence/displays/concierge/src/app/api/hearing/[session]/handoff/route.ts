import type { NextRequest } from 'next/server';
import { handOffHearingToMission } from '@agent/core/surface/hearing-session-service';
import { runHearingRoute } from '../../../../../lib/hearing-access';

export const dynamic = 'force-dynamic';

/**
 * Hand a decided hearing off to the governed mission and alignment flow (moved
 * from presence-studio `POST /api/hearing/:session/handoff`); idempotent per session.
 * Owner only; same origin (an `Origin` or `Referer` header is required, also for
 * bearer clients: 403 `hearing_origin_denied`); then the shared write guard
 * (`lib/hearing-access.ts`).
 */
export async function POST(req: NextRequest, context: { params: Promise<{ session: string }> }) {
  const { session } = await context.params;
  return runHearingRoute(
    req,
    { mode: 'write', operation: 'hearing.handoff', family: 'mission', session },
    (ctx, { query, body }) => handOffHearingToMission(ctx, session, body, query)
  );
}
