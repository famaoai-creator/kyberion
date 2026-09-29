import { NextRequest, NextResponse } from 'next/server';
import { ensureDiscussionRunning } from '@agent/core/discussion/discussion-engine';
import {
  readDiscussionRoom,
  sanitizeDiscussionId,
  submitDiscussionCommand,
} from '@agent/core/discussion/discussion-store';
import type {
  DiscussionCommand,
  DiscussionCommandKind,
} from '@agent/core/discussion/discussion-types';
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

const COMMAND_KINDS: readonly DiscussionCommandKind[] = [
  'pause',
  'resume',
  'inject',
  'redirect',
  'ask',
  'open_vote',
  'cast_vote',
  'conclude',
  'stop',
  'set_speaker',
];
const TEXT_KINDS = new Set<DiscussionCommandKind>(['inject', 'redirect', 'ask', 'open_vote']);

function parseCommand(body: Record<string, unknown>): DiscussionCommand | string {
  const kind = body.kind;
  if (typeof kind !== 'string' || !COMMAND_KINDS.includes(kind as DiscussionCommandKind)) {
    return 'unknown command kind';
  }
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 1000) : undefined;
  if (TEXT_KINDS.has(kind as DiscussionCommandKind) && !text) return 'text is required';
  const options = Array.isArray(body.options)
    ? body.options
        .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
        .map((o) => o.trim().slice(0, 60))
        .slice(0, 5)
    : undefined;
  return {
    kind: kind as DiscussionCommandKind,
    ...(text ? { text } : {}),
    ...(typeof body.target === 'string' && body.target ? { target: body.target.slice(0, 64) } : {}),
    ...(options?.length ? { options } : {}),
    ...(typeof body.choice === 'string' && body.choice ? { choice: body.choice.slice(0, 60) } : {}),
  };
}

/** Human steering: pause, inject, redirect, ask, vote, conclude, stop. */
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
    const parsed = await readChronosJsonObject(req, 'Chronos discussion command');
    if (parsed.ok !== true) {
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
    }
    const command = parseCommand(parsed.body);
    if (typeof command === 'string') {
      return NextResponse.json({ ok: false, error: command }, { status: 400 });
    }
    const room = withViewerExecutionContext(viewer, () => readDiscussionRoom(roomId));
    if (!room)
      return NextResponse.json({ ok: false, error: 'discussion not found' }, { status: 404 });
    assertDiscussionVisible(viewer, room.scope);
    if (room.status === 'concluded' || room.status === 'stopped') {
      return NextResponse.json(
        { ok: false, error: `discussion already ${room.status}` },
        { status: 409 }
      );
    }
    const next = withViewerExecutionContext(viewer, () => {
      submitDiscussionCommand(roomId, viewer.principalId ?? viewer.role, command);
      // Re-attach an engine if the server restarted mid-discussion.
      void ensureDiscussionRunning(roomId);
      return readDiscussionRoom(roomId);
    });
    return NextResponse.json({ ok: true, room: next }, { status: 202 });
  } catch (error) {
    return viewerErrorResponse(error, 400);
  }
}
