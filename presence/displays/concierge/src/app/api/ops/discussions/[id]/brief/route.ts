import { NextRequest, NextResponse } from 'next/server';
import { renderDiscussionBriefHtml } from '@agent/core/discussion/discussion-brief';
import { readDiscussionRoom, sanitizeDiscussionId } from '@agent/core/discussion/discussion-store';
import {
  guardOpsRequest,
  requireOpsAccess,
  resolveOpsAccessRole,
} from '../../../../../../lib/ops/ops-request-guard';
import { assertDiscussionVisible } from '../../../../../../lib/ops/discussion-access';
import { readChronosOptionalStringParam } from '../../../../../../lib/ops/request-input';
import {
  resolveOpsViewerForRequest,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../../../lib/ops/ops-viewer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The decision brief document. It is loaded in a sandboxed iframe, so the CSP
 * `sandbox` gives it an opaque origin even when opened directly: it can run
 * its own inline script but cannot reach Chronos, the network, or cookies.
 * `?mode=review` adds the edit / decide controls, and only for `localadmin`.
 */
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const viewer = resolvedViewer.context;
  try {
    const roomId = sanitizeDiscussionId((await context.params).id);
    const room = withViewerExecutionContext(viewer, () => readDiscussionRoom(roomId));
    if (!room)
      return NextResponse.json({ ok: false, error: 'discussion not found' }, { status: 404 });
    assertDiscussionVisible(viewer, room.scope);
    const wantsReview =
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('mode')) === 'review';
    const mode = wantsReview && resolveOpsAccessRole(req) === 'localadmin' ? 'review' : 'view';
    const html = renderDiscussionBriefHtml(room, { mode });
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
      },
    });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
