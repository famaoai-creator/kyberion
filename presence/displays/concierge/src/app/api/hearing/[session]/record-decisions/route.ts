import type { NextRequest } from 'next/server';
import { hearingLedgerUnavailable } from '../../../../../lib/hearing-access';

export const dynamic = 'force-dynamic';

/**
 * Answered requirements as decision-ledger promotions (presence-studio
 * `POST /api/hearing/:session/record-decisions`). Not served on Concierge
 * yet: the `decisions import` facade writes the ledger as `decision_ledger`,
 * which the concierge role may not assume (CD-12), and an unbounded child
 * would bypass that (H1). After the owner, origin and write-guard gate, a
 * coded 503 `hearing_ledger_unavailable` (`lib/hearing-access.ts`).
 */
export function POST(req: NextRequest) {
  return hearingLedgerUnavailable(req, 'write', 'hearing.record_decisions');
}
