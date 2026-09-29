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

const VERDICTS: readonly DiscussionReviewVerdict[] = ['accept', 'request-changes', 'reject'];

/** The human decision on a decision brief: accept (creates work, may request a mission), send back, or reject. */
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
