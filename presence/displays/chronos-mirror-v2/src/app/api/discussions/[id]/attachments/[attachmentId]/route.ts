import { NextRequest, NextResponse } from 'next/server';
import {
  attachmentContentType,
  isInlineAttachment,
  readDiscussionAttachment,
} from '@agent/core/discussion/discussion-attachments';
import { readDiscussionRoom, sanitizeDiscussionId } from '@agent/core/discussion/discussion-store';
import { guardRequest, requireChronosAccess } from '../../../../../../lib/api-guard';
import { assertDiscussionVisible } from '../../../../../../lib/discussion-access';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../../../lib/viewer-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serve an attachment back to viewers who can see the room. The type comes from
 * the extension allow-list (never the uploader), images render inline, everything
 * else downloads, and a sandbox CSP keeps even a hostile file inert.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string; attachmentId: string }> }
) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const viewer = resolvedViewer.context;
  try {
    const params = await context.params;
    const roomId = sanitizeDiscussionId(params.id);
    const room = withViewerExecutionContext(viewer, () => readDiscussionRoom(roomId));
    if (!room)
      return NextResponse.json({ ok: false, error: 'discussion not found' }, { status: 404 });
    assertDiscussionVisible(viewer, room.scope);
    const file = withViewerExecutionContext(viewer, () =>
      readDiscussionAttachment(roomId, params.attachmentId)
    );
    if (!file)
      return NextResponse.json({ ok: false, error: 'attachment not found' }, { status: 404 });
    const inline = isInlineAttachment(file.name);
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        'Content-Type': attachmentContentType(file.name),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy':
          "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      },
    });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
