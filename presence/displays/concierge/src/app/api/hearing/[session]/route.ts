import type { NextRequest } from 'next/server';
import { readHearingSession } from '@agent/core/surface/hearing-session-service';
import { runHearingRoute } from '../../../../lib/hearing-access';

export const dynamic = 'force-dynamic';

/**
 * 頼む › ヒアリング: one hearing record with its labels in the request locale,
 * its completion proof and what to ask next (moved from presence-studio
 * `GET /api/hearing/:session`, Kyberion server phase 2). Any viewer reads a
 * tenant hearing; only the installation owner reads the personal one
 * (`lib/hearing-access.ts`). The step is the shared
 * `@agent/core/surface/hearing-session-service`.
 */
export async function GET(req: NextRequest, context: { params: Promise<{ session: string }> }) {
  const { session } = await context.params;
  return runHearingRoute(
    req,
    { mode: 'read', operation: 'hearing.read', family: 'session' },
    (ctx, { query }) => readHearingSession(ctx, session, query)
  );
}
