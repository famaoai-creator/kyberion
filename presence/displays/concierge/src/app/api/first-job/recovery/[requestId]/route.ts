import { NextResponse, type NextRequest } from 'next/server';
import { parseFirstJobRecoveryRequest } from '@agent/core/surface/first-job-contract';
import { FirstJobApprovalError } from '@agent/core/surface/first-job-approval';
import { terminateFirstJobRequest } from '@agent/core/surface/first-job-recovery';
import { resolveFirstJobGate } from '../../../../../lib/first-job-access';
import {
  FIRST_JOB_NO_STORE,
  firstJobFailure,
  firstJobGateFailure,
  firstJobQuery,
  firstJobUnexpected,
  readFirstJobBody,
} from '../../../../../lib/first-job-server';

export const dynamic = 'force-dynamic';

/**
 * 初めての仕事: end one held diagnostic request that never started (moved
 * from presence-studio `POST /api/first-job/recovery/:requestId`). A separate
 * terminal operation; it never reuses an approval to run work.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ requestId: string }> }
) {
  try {
    const gate = resolveFirstJobGate(req, true);
    if (gate.denial) return firstJobGateFailure(gate.denial, false);
    const { viewer, credential } = gate;
    const { requestId } = await params;
    const input = parseFirstJobRecoveryRequest(await readFirstJobBody(req));
    if (!input || Object.keys(firstJobQuery(req)).length !== 0 || typeof requestId !== 'string')
      return firstJobFailure(400, 'first_job_invalid_request', true);
    return NextResponse.json(terminateFirstJobRequest(viewer, credential, requestId, input), {
      headers: FIRST_JOB_NO_STORE,
    });
  } catch (error) {
    if (error instanceof FirstJobApprovalError)
      return firstJobFailure(error.status, error.message, false);
    return firstJobUnexpected(
      'POST /api/first-job/recovery/:requestId',
      error,
      'first_job_recovery_uncertain',
      false
    );
  }
}
