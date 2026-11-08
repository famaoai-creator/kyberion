import type { NextRequest } from 'next/server';
import { hearingLedgerUnavailable } from '../../../../../lib/hearing-access';

export const dynamic = 'force-dynamic';

/**
 * The open decisions of one case as a hearing scenario (presence-studio
 * `GET /api/hearing/decisions/agenda`). Not served on Concierge yet: reading
 * the tenant decision ledger needs `decision_ledger`, which the concierge
 * role may not assume (CD-12). After the viewer gate, a coded 503
 * `hearing_ledger_unavailable` (`lib/hearing-access.ts`).
 */
export function GET(req: NextRequest) {
  return hearingLedgerUnavailable(req, 'read', 'hearing.agenda');
}
