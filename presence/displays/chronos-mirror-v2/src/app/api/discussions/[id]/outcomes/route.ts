import { NextRequest, NextResponse } from 'next/server';
import { createWorkItemsFromDecision } from '@agent/core/discussion/discussion-outcomes';
import { readDiscussionRoom, sanitizeDiscussionId } from '@agent/core/discussion/discussion-store';
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

/**
 * The human gate between a decision and real work: turn selected follow-up
 * proposals into backlog WorkItems that carry the room's context chain.
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
    const parsed = await readChronosJsonObject(req, 'Chronos discussion outcomes');
    if (parsed.ok !== true) {
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
    }
    if (parsed.body.action !== 'create_workitems') {
      return NextResponse.json({ ok: false, error: 'unknown outcome action' }, { status: 400 });
    }
    const proposalIds = Array.isArray(parsed.body.proposal_ids)
      ? parsed.body.proposal_ids.filter((id): id is string => typeof id === 'string').slice(0, 16)
      : undefined;
    const room = withViewerExecutionContext(viewer, () => readDiscussionRoom(roomId));
    if (!room)
      return NextResponse.json({ ok: false, error: 'discussion not found' }, { status: 404 });
    assertDiscussionVisible(viewer, room.scope);
    if (!room.decision) {
      return NextResponse.json(
        { ok: false, error: 'the discussion has no decision yet' },
        { status: 409 }
      );
    }
    const result = withViewerExecutionContext(viewer, () =>
      createWorkItemsFromDecision(roomId, viewer.principalId ?? viewer.role, proposalIds)
    );
    return NextResponse.json({
      ok: true,
      created: result.created,
      skipped: result.skipped,
      room: withViewerExecutionContext(viewer, () => readDiscussionRoom(roomId)),
    });
  } catch (error) {
    return viewerErrorResponse(error, 400);
  }
}
