import { NextRequest, NextResponse } from 'next/server';
import { listConciergeMemoryQueue } from '../../../lib/needs-you-server';
import { resolveConciergeSelectedViewer } from '../../../lib/selected-tenant';
import { conciergeErrorResponse } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

/**
 * CS-03 記憶昇格キュー — read-only list of memory-promotion candidates still
 * waiting for the human's decision (status `queued`). Kind and tier codes are
 * translated to plain language client-side via i18n; this route never mutates
 * the queue — approving/rejecting is a separate guarded POST
 * (api/memory-queue/[id]) that runs the built controller CLI. The same reader
 * feeds the needs-you queue (`/api/v1/needs-you`).
 */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) return resolved.response;
  try {
    return NextResponse.json({
      ok: true,
      candidates: listConciergeMemoryQueue(resolved.context),
    });
  } catch (error) {
    return conciergeErrorResponse(error);
  }
}
