import { NextResponse, type NextRequest } from 'next/server';
import { parseFirstJobApprovalDecisionRequest } from '@agent/core/surface/first-job-contract';
import {
  decideFirstJobApproval,
  FirstJobApprovalError,
} from '@agent/core/surface/first-job-approval';
import { resolveFirstJobGate } from '../../../../../../lib/first-job-access';
import {
  FIRST_JOB_NO_STORE,
  firstJobFailure,
  firstJobGateFailure,
  firstJobQuery,
  firstJobUnexpected,
  readFirstJobBody,
} from '../../../../../../lib/first-job-server';

export const dynamic = 'force-dynamic';

/**
 * 初めての仕事: approve or reject one held diagnostic request (moved from
 * presence-studio `POST /api/first-job/approvals/:requestId/decision`). The
 * shared writer re-verifies the browser session, the owner and the exact
 * displayed effect inside its lock.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ requestId: string }> }
) {
  try {
    const gate = resolveFirstJobGate(req, true);
    if (gate.denial) return firstJobGateFailure(gate.denial, true);
    const { viewer, credential } = gate;
    const { requestId } = await params;
    const input = parseFirstJobApprovalDecisionRequest(await readFirstJobBody(req));
    if (!input || Object.keys(firstJobQuery(req)).length !== 0 || typeof requestId !== 'string')
      return firstJobFailure(400, 'first_job_invalid_request', true);
    const result = decideFirstJobApproval(viewer, credential, requestId, input);
    return NextResponse.json(
      { ok: true, approval_request_id: result.id, status: result.status },
      { headers: FIRST_JOB_NO_STORE }
    );
  } catch (error) {
    if (error instanceof FirstJobApprovalError)
      return firstJobFailure(error.status, error.message, error.status !== 503);
    return firstJobUnexpected(
      'POST /api/first-job/approvals/:requestId/decision',
      error,
      'first_job_decision_uncertain',
      false
    );
  }
}
