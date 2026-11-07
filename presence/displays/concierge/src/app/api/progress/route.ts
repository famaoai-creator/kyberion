import { NextRequest, NextResponse } from 'next/server';
import {
  PROGRESS_NO_STORE,
  progressReadFailed,
  resolveProgressScope,
} from '../../../lib/progress-request';
import { readProgress } from '../../../lib/progress-server';
import { conciergeErrorResponse } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

/**
 * 仕事 › 依頼: the viewer's requests — in progress, delivered, done
 * (`lib/progress-server.ts`). Moved from presence-studio `GET /api/progress`
 * (Kyberion server phase 2). Read-only; the viewer is resolved server-side
 * and `tenant` / `organizationId` / `projectId` only narrow it.
 */
export function GET(req: NextRequest) {
  let resolved: ReturnType<typeof resolveProgressScope>;
  try {
    resolved = resolveProgressScope(req);
  } catch (error) {
    return conciergeErrorResponse(error);
  }
  if (resolved.response) return resolved.response;
  try {
    return NextResponse.json(readProgress(resolved.scope), { headers: PROGRESS_NO_STORE });
  } catch (error) {
    return progressReadFailed('GET /api/progress', error);
  }
}
