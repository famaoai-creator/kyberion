import { NextRequest, NextResponse } from 'next/server';
import { ensureDiscussionRunning } from '@agent/core/discussion/discussion-engine';
import { withLiveMissionStatus } from '@agent/core/discussion/discussion-mission';
import { reviewDiscussion } from '@agent/core/discussion/discussion-review';
import {
  readDiscussionRoom,
  sanitizeDiscussionId,
  DiscussionUserError,
} from '@agent/core/discussion/discussion-store';
import type { DiscussionReviewVerdict } from '@agent/core/discussion/discussion-types';
import { guardOpsRequest, requireOpsAccess } from '../../../../../../lib/ops/ops-request-guard';
import { assertDiscussionVisible } from '../../../../../../lib/ops/discussion-access';
import { readChronosJsonObject } from '../../../../../../lib/ops/request-input';
import {
  resolveOpsViewerForRequest,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../../../lib/ops/ops-viewer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VERDICTS: readonly DiscussionReviewVerdict[] = ['accept', 'request-changes', 'reject'];

/** The human decision on a decision brief: accept (creates work, may request a mission), send back, or reject. */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'localadmin');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const viewer = resolvedViewer.context;
  try {
    const roomId = sanitizeDiscussionId((await context.params).id);
    const parsed = await readChronosJsonObject(req, 'Chronos discussion review');
    if (parsed.ok !== true) {
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
    }
    const verdict = parsed.body.verdict;
    if (typeof verdict !== 'string' || !VERDICTS.includes(verdict as DiscussionReviewVerdict)) {
      return NextResponse.json({ ok: false, error: 'unknown verdict' }, { status: 400 });
    }
    const edits = Array.isArray(parsed.body.edits)
      ? parsed.body.edits.slice(0, 16).flatMap((edit) => {
          if (!edit || typeof edit !== 'object') return [];
          const e = edit as Record<string, unknown>;
          if (typeof e.id !== 'string') return [];
          return [
            {
              id: e.id,
              ...(typeof e.title === 'string' ? { title: e.title } : {}),
              ...(typeof e.priority === 'string' ? { priority: e.priority } : {}),
              ...(e.owner_role === null || typeof e.owner_role === 'string'
                ? { owner_role: e.owner_role as string | null }
                : {}),
              ...(typeof e.included === 'boolean' ? { included: e.included } : {}),
            },
          ];
        })
      : undefined;
    const room = withViewerExecutionContext(viewer, () => readDiscussionRoom(roomId));
    if (!room)
      return NextResponse.json({ ok: false, error: 'discussion not found' }, { status: 404 });
    assertDiscussionVisible(viewer, room.scope);
    if (
      verdict === 'request-changes' &&
      (room.config.speaker !== 'scripted' || room.execution?.actual_mode === 'reasoning')
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'This bounded provider run cannot be reopened. Start a new room; the saved decision is preserved.',
        },
        { status: 409 }
      );
    }
    const result = withViewerExecutionContext(viewer, () => {
      const outcome = reviewDiscussion(roomId, viewer.principalId ?? viewer.role, {
        verdict: verdict as DiscussionReviewVerdict,
        note: typeof parsed.body.note === 'string' ? parsed.body.note : undefined,
        edits,
        request_mission: parsed.body.request_mission === true,
      });
      // A sent-back room goes back to work; re-attach its engine.
      if (outcome.reopened) void ensureDiscussionRunning(roomId);
      return outcome;
    });
    const next = withViewerExecutionContext(viewer, () => readDiscussionRoom(roomId));
    return NextResponse.json({ ok: true, result, room: next ? withLiveMissionStatus(next) : null });
  } catch (error) {
    if (error instanceof DiscussionUserError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    return viewerErrorResponse(error, 400);
  }
}
