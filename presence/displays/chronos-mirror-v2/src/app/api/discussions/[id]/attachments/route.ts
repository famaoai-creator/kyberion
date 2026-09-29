import { NextRequest, NextResponse } from 'next/server';
import {
  addDiscussionAttachment,
  MAX_ATTACHMENT_BYTES,
} from '@agent/core/discussion/discussion-attachments';
import {
  DiscussionUserError,
  readDiscussionRoom,
  sanitizeDiscussionId,
} from '@agent/core/discussion/discussion-store';
import { guardRequest, requireChronosAccess } from '../../../../../lib/api-guard';
import { assertDiscussionVisible } from '../../../../../lib/discussion-access';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  withViewerExecutionContextAsync,
  withViewerExecutionContext,
} from '../../../../../lib/viewer-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FILES_PER_REQUEST = 4;

/** Upload files to attach to the next message. Content is read best-effort; type and size are enforced by the core. */
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
    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > MAX_ATTACHMENT_BYTES * MAX_FILES_PER_REQUEST + 65536) {
      return NextResponse.json({ ok: false, error: 'upload too large' }, { status: 413 });
    }
    const room = withViewerExecutionContext(viewer, () => readDiscussionRoom(roomId));
    if (!room)
      return NextResponse.json({ ok: false, error: 'discussion not found' }, { status: 404 });
    assertDiscussionVisible(viewer, room.scope);
    const form = await req.formData();
    const files = form.getAll('file').filter((entry): entry is File => entry instanceof File);
    if (files.length === 0 || files.length > MAX_FILES_PER_REQUEST) {
      return NextResponse.json(
        { ok: false, error: 'attach between 1 and 4 files' },
        { status: 400 }
      );
    }
    const actor = viewer.principalId ?? viewer.role;
    const attachments = [];
    for (const file of files) {
      const bytes = Buffer.from(await file.arrayBuffer());
      attachments.push(
        await withViewerExecutionContextAsync(viewer, () =>
          addDiscussionAttachment(roomId, actor, { name: file.name, bytes })
        )
      );
    }
    return NextResponse.json({ ok: true, attachments }, { status: 201 });
  } catch (error) {
    if (error instanceof DiscussionUserError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    return viewerErrorResponse(error, 400);
  }
}
