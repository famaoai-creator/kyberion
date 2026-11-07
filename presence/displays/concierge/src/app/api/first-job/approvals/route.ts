import { NextResponse, type NextRequest } from 'next/server';
import { normalizeLocale } from '@agent/core/foundation/locale-normalize';
import { parseFirstJobReadRequest } from '@agent/core/surface/first-job-contract';
import { readFirstJobApprovals } from '@agent/core/surface/first-job-approval';
import { readFirstJobRecoveries } from '@agent/core/surface/first-job-recovery';
import { resolveFirstJobGate } from '../../../../lib/first-job-access';
import {
  FIRST_JOB_NO_STORE,
  firstJobFailure,
  firstJobGateFailure,
  firstJobQuery,
  firstJobUnexpected,
} from '../../../../lib/first-job-server';

export const dynamic = 'force-dynamic';

/**
 * 初めての仕事: the held approvals and recovery candidates of this owner's
 * diagnostic (moved from presence-studio `GET /api/first-job/approvals`).
 * Read-only; the browser session is verified by the shared approval reader.
 */
export function GET(req: NextRequest) {
  try {
    const gate = resolveFirstJobGate(req, false);
    if (gate.denial) return firstJobGateFailure(gate.denial, true);
    const { viewer, credential } = gate;
    const input = parseFirstJobReadRequest(firstJobQuery(req));
    if (!input || (input.locale !== undefined && !normalizeLocale(input.locale)))
      return firstJobFailure(400, 'first_job_invalid_request', true);
    const approvals = readFirstJobApprovals(viewer, credential, input);
    const recovery_requests =
      approvals.auth.status === 'ready' && approvals.readiness.ready
        ? readFirstJobRecoveries(viewer, credential, input)
        : [];
    return NextResponse.json(
      {
        ...approvals,
        recovery_requests,
        held_requests: approvals.held_requests.filter(
          (held) => !recovery_requests.some((row) => row.request_id === held.request_id)
        ),
      },
      { headers: FIRST_JOB_NO_STORE }
    );
  } catch (error) {
    return firstJobUnexpected(
      'GET /api/first-job/approvals',
      error,
      'first_job_approvals_unavailable',
      true
    );
  }
}
