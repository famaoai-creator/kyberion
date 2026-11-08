import type { NextRequest } from 'next/server';
import { readHearingCanvas } from '@agent/core/surface/hearing-session-service';
import { runHearingRoute } from '../../../../../lib/hearing-access';

export const dynamic = 'force-dynamic';

/**
 * The hearing's canvas (HTML for the page's sandboxed frame), moved from
 * presence-studio `GET /api/hearing/:session/canvas`. Same access as the
 * record (`lib/hearing-access.ts`).
 */
export async function GET(req: NextRequest, context: { params: Promise<{ session: string }> }) {
  const { session } = await context.params;
  return runHearingRoute(
    req,
    { mode: 'read', operation: 'hearing.canvas', family: 'session' },
    (ctx, { query }) => readHearingCanvas(ctx, session, query)
  );
}
