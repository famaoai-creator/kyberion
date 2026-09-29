import { NextRequest, NextResponse } from 'next/server';
import {
  issueMissionForDiscussion,
  withLiveMissionStatus,
} from '@agent/core/discussion/discussion-mission';
import {
  readDiscussionRoom,
  sanitizeDiscussionId,
  DiscussionUserError,
} from '@agent/core/discussion/discussion-store';
import { guardRequest, requireChronosAccess } from '../../../../../lib/api-guard';
import { assertDiscussionVisible } from '../../../../../lib/discussion-access';
import { readChronosJsonObject } from '../../../../../lib/request-input';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  withViewerExecutionContextAsync,
  withViewerExecutionContext,
} from '../../../../../lib/viewer-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Start the mission an approved request stands for. The approval, not this
 * click, is the authority: without an approved request bound to the room the
 * core refuses, and the mission itself is issued through mission_controller.
 */
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
    const parsed = await readChronosJsonObject(req, 'Chronos discussion mission');
    if (parsed.ok !== true) {
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
    }
    if (parsed.body.action !== 'issue') {
      return NextResponse.json({ ok: false, error: 'unknown mission action' }, { status: 400 });
    }
    const room = withViewerExecutionContext(viewer, () => readDiscussionRoom(roomId));
    if (!room)
      return NextResponse.json({ ok: false, error: 'discussion not found' }, { status: 404 });
    assertDiscussionVisible(viewer, room.scope);
    const result = await withViewerExecutionContextAsync(viewer, () =>
      issueMissionForDiscussion(roomId, viewer.principalId ?? viewer.role)
    );
    const next = withViewerExecutionContext(viewer, () => readDiscussionRoom(roomId));
    return NextResponse.json({ ok: true, result, room: next ? withLiveMissionStatus(next) : null });
  } catch (error) {
    if (error instanceof DiscussionUserError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    return viewerErrorResponse(error, 400);
  }
}
