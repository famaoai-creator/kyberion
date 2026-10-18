import { NextRequest, NextResponse } from 'next/server';
import {
  readSavedDiscussionArtifact,
  SavedDiscussionArtifactError,
} from '@agent/core/discussion/discussion-outcomes';
import { readDiscussionRoom, sanitizeDiscussionId } from '@agent/core/discussion/discussion-store';
import { guardRequest, requireChronosAccess } from '../../../../../../lib/api-guard';
import { assertDiscussionVisible } from '../../../../../../lib/discussion-access';
import {
  resolveViewerContextForRequest,
  strictViewerTier,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../../../lib/viewer-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Exact persisted bytes, separate from the generated/review brief endpoint. */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string; artifactId: string }> }
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
    if (roomId !== params.id || roomId === '.' || roomId === '..') {
      return NextResponse.json({ ok: false, error: 'Invalid discussion room id' }, { status: 400 });
    }
    const room = withViewerExecutionContext(viewer, () => readDiscussionRoom(roomId));
    if (!room)
      return NextResponse.json({ ok: false, error: 'discussion not found' }, { status: 404 });
    assertDiscussionVisible(viewer, room.scope);
    strictViewerTier(viewer, room.scope.tier ?? 'confidential');
    const file = withViewerExecutionContext(viewer, () =>
      readSavedDiscussionArtifact(room, params.artifactId)
    );
    if (!file)
      return NextResponse.json({ ok: false, error: 'saved artifact not found' }, { status: 404 });
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        'Content-Type':
          file.kind === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
        'Content-Length': String(file.bytes.length),
        'Content-Disposition': 'inline; filename="' + file.name + '"',
        'X-Content-Type-Options': 'nosniff',
        'X-Artifact-Integrity': 'verified',
        'X-Artifact-SHA256': file.sha256,
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy':
          "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      },
    });
  } catch (error) {
    if (error instanceof SavedDiscussionArtifactError) {
      return NextResponse.json(
        { ok: false, error: error.message, error_code: 'saved_artifact_' + error.code },
        {
          status: error.status,
          headers: { 'Cache-Control': 'private, no-store', 'X-Artifact-Integrity': 'unverified' },
        }
      );
    }
    return viewerErrorResponse(error);
  }
}
