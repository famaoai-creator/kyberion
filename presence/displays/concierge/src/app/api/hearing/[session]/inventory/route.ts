import type { NextRequest } from 'next/server';
import { saveHearingInventory } from '@agent/core/surface/hearing-session-service';
import { runHearingRoute } from '../../../../../lib/hearing-access';

export const dynamic = 'force-dynamic';

/**
 * Save a decided work-inventory hearing as a work-inventory entry (moved from
 * presence-studio `POST /api/hearing/:session/inventory`); idempotent per session.
 * Owner only; same origin (an `Origin` or `Referer` header is required, also for
 * bearer clients: 403 `hearing_origin_denied`); then the shared write guard
 * (`lib/hearing-access.ts`).
 */
export async function POST(req: NextRequest, context: { params: Promise<{ session: string }> }) {
  const { session } = await context.params;
  return runHearingRoute(
    req,
    { mode: 'write', operation: 'hearing.inventory', family: 'session', session },
    (ctx, { query, body }) => saveHearingInventory(ctx, session, body, query)
  );
}
