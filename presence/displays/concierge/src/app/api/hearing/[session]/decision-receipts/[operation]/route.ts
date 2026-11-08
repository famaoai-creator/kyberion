import type { NextRequest } from 'next/server';
import { readHearingDecisionReceipt } from '@agent/core/surface/hearing-session-service';
import { runHearingRoute } from '../../../../../../lib/hearing-access';

export const dynamic = 'force-dynamic';

/**
 * Read-only exact decision receipt (moved from presence-studio
 * `GET /api/hearing/:session/decision-receipts/:operation`). Absence is
 * unknown, never evidence of non-execution. Owner only, as Studio's
 * local-admin check (`lib/hearing-access.ts`).
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ session: string; operation: string }> }
) {
  const { session, operation } = await context.params;
  return runHearingRoute(
    req,
    { mode: 'owner-read', operation: 'hearing.decision_receipt', family: 'session' },
    (ctx, { query }) => readHearingDecisionReceipt(ctx, session, operation, query)
  );
}
