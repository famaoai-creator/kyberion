import type { NextRequest } from 'next/server';
import { decideHearing } from '@agent/core/surface/hearing-session-service';
import { runHearingRoute } from '../../../../../lib/hearing-access';

export const dynamic = 'force-dynamic';

/**
 * Record the human decision on a hearing (moved from presence-studio
 * `POST /api/hearing/:session/decide`); the member is resolved server-side.
 * Owner only; same origin (an `Origin` or `Referer` header is required, also for
 * bearer clients: 403 `hearing_origin_denied`); then the shared write guard
 * (`lib/hearing-access.ts`).
 */
export async function POST(req: NextRequest, context: { params: Promise<{ session: string }> }) {
  const { session } = await context.params;
  return runHearingRoute(
    req,
    { mode: 'write', operation: 'hearing.decide', family: 'session', session },
    (ctx, { query, body }) => decideHearing(ctx, session, body, query)
  );
}
