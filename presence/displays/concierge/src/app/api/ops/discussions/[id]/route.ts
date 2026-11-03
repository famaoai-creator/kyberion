import { NextRequest, NextResponse } from 'next/server';
import {
  archiveDiscussionRoom,
  renameDiscussionRoom,
} from '@agent/core/discussion/discussion-dialogue-actions';
import { withLiveReply } from '@agent/core/discussion/discussion-live';
import { withLiveMissionStatus } from '@agent/core/discussion/discussion-mission';
import {
  DiscussionUserError,
  readDiscussionRoom,
  sanitizeDiscussionId,
} from '@agent/core/discussion/discussion-store';
import { guardOpsRequest, requireOpsAccess } from '../../../../../lib/ops/ops-request-guard';
import { assertDiscussionVisible } from '../../../../../lib/ops/discussion-access';
import { readChronosJsonObject } from '../../../../../lib/ops/request-input';
import {
  resolveOpsViewerForRequest,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../../lib/ops/ops-viewer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const viewer = resolvedViewer.context;
  try {
    const { id } = await context.params;
    const room = withViewerExecutionContext(viewer, () =>
      readDiscussionRoom(sanitizeDiscussionId(id))
    );
    if (!room)
      return NextResponse.json({ ok: false, error: 'discussion not found' }, { status: 404 });
    assertDiscussionVisible(viewer, room.scope);
    return NextResponse.json({
      ok: true,
      room: withLiveReply(withLiveMissionStatus(room)),
      accessRole: viewer.role,
    });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}

/** Rename or archive a conversation. */
export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'localadmin');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const viewer = resolvedViewer.context;
  try {
    const roomId = sanitizeDiscussionId((await context.params).id);
    const parsed = await readChronosJsonObject(req, 'Chronos discussion update');
    if (parsed.ok !== true) {
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
    }
    const room = withViewerExecutionContext(viewer, () => readDiscussionRoom(roomId));
    if (!room)
      return NextResponse.json({ ok: false, error: 'discussion not found' }, { status: 404 });
    assertDiscussionVisible(viewer, room.scope);
    const actor = viewer.principalId ?? viewer.role;
    withViewerExecutionContext(viewer, () => {
      if (typeof parsed.body.title === 'string')
        renameDiscussionRoom(roomId, actor, parsed.body.title);
      if (typeof parsed.body.archived === 'boolean') {
        archiveDiscussionRoom(roomId, actor, parsed.body.archived);
      }
    });
    const next = withViewerExecutionContext(viewer, () => readDiscussionRoom(roomId));
    return NextResponse.json({
      ok: true,
      room: next ? withLiveReply(withLiveMissionStatus(next)) : null,
    });
  } catch (error) {
    if (error instanceof DiscussionUserError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    return viewerErrorResponse(error, 400);
  }
}
