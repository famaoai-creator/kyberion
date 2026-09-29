import { NextRequest, NextResponse } from 'next/server';
import { recordMessageFeedback } from '@agent/core/discussion/discussion-dialogue-actions';
import {
  DiscussionUserError,
  readDiscussionRoom,
  sanitizeDiscussionId,
} from '@agent/core/discussion/discussion-store';
import { guardRequest, requireChronosAccess } from '../../../../../lib/api-guard';
import { assertDiscussionVisible } from '../../../../../lib/discussion-access';
import { readChronosJsonObject } from '../../../../../lib/request-input';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../../lib/viewer-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Thumbs up / down on an assistant message; `value: null` clears it. */
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
    const parsed = await readChronosJsonObject(req, 'Chronos discussion feedback');
    if (parsed.ok !== true) {
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
    }
    const { message_id: messageId, value: rawValue } = parsed.body;
    const value: 'up' | 'down' | null = rawValue === 'up' || rawValue === 'down' ? rawValue : null;
    if (typeof messageId !== 'string' || (value === null && rawValue !== null)) {
      return NextResponse.json({ ok: false, error: 'invalid feedback' }, { status: 400 });
    }
    const room = withViewerExecutionContext(viewer, () => readDiscussionRoom(roomId));
    if (!room)
      return NextResponse.json({ ok: false, error: 'discussion not found' }, { status: 404 });
    assertDiscussionVisible(viewer, room.scope);
    withViewerExecutionContext(viewer, () =>
      recordMessageFeedback(roomId, viewer.principalId ?? viewer.role, messageId, value)
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof DiscussionUserError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    return viewerErrorResponse(error, 400);
  }
}
