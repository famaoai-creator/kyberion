import { NextResponse, type NextRequest } from 'next/server';
import { parseFirstJobArtifactReadRequest } from '@agent/core/surface/first-job-contract';
import { readFirstJobArtifact } from '@agent/core/surface/first-job';
import { resolveFirstJobGate } from '../../../../lib/first-job-access';
import {
  FIRST_JOB_NO_STORE,
  firstJobFailure,
  firstJobGateFailure,
  firstJobQuery,
  firstJobUnexpected,
} from '../../../../lib/first-job-server';

export const dynamic = 'force-dynamic';

const HEADERS = { ...FIRST_JOB_NO_STORE, 'X-Content-Type-Options': 'nosniff' } as const;

/**
 * 初めての仕事: one exact verified receipt version of this owner's diagnostic
 * (moved from presence-studio `GET /api/first-job/artifact`). The query is a
 * version selector, never a path.
 */
export function GET(req: NextRequest) {
  const nosniff = (response: Response) => {
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  };
  try {
    const gate = resolveFirstJobGate(req, false);
    if (gate.denial) return nosniff(firstJobGateFailure(gate.denial, true));
    const input = parseFirstJobArtifactReadRequest(firstJobQuery(req));
    if (!input) return nosniff(firstJobFailure(400, 'first_job_invalid_request', true));
    const result = readFirstJobArtifact(gate.viewer, input);
    return result
      ? NextResponse.json(result, { headers: HEADERS })
      : nosniff(firstJobFailure(404, 'first_job_artifact_unavailable', true));
  } catch (error) {
    return nosniff(
      firstJobUnexpected(
        'GET /api/first-job/artifact',
        error,
        'first_job_artifact_unavailable',
        true
      )
    );
  }
}
