import { NextRequest, NextResponse } from 'next/server';
import { stopDiscussionGeneration } from '@agent/core/discussion/discussion-dialogue-actions';
import { readDiscussionRoom, sanitizeDiscussionId } from '@agent/core/discussion/discussion-store';
import { guardRequest, requireChronosAccess } from '../../../../../lib/api-guard';
import { assertDiscussionVisible } from '../../../../../lib/discussion-access';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../../lib/viewer-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Stop the reply being generated right now (the Stop button). */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'localadmin');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const viewer = resolvedViewer.context;
  try {
    const roomId = sanitizeDiscussionId((await context.params).id);
    const room = withViewerExecutionContext(viewer, () => readDiscussionRoom(roomId));
    if (!room)
      return NextResponse.json({ ok: false, error: 'discussion not found' }, { status: 404 });
    assertDiscussionVisible(viewer, room.scope);
    return NextResponse.json({ ok: true, stopped: stopDiscussionGeneration(roomId) });
  } catch (error) {
    return viewerErrorResponse(error, 400);
  }
}
