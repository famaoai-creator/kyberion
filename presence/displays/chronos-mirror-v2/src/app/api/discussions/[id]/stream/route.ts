import { NextRequest } from 'next/server';
import { withLiveMissionStatus } from '@agent/core/discussion/discussion-mission';
import { readDiscussionRoom, sanitizeDiscussionId } from '@agent/core/discussion/discussion-store';
import { guardRequest, requireChronosAccess } from '../../../../../lib/api-guard';
import { assertDiscussionVisible } from '../../../../../lib/discussion-access';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../../lib/viewer-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sse(eventName: string, data: unknown, id?: number): string {
  return `${id !== undefined ? `id: ${id}\n` : ''}event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

const TERMINAL = new Set(['concluded', 'stopped', 'failed']);

/**
 * Server-sent room state. Each frame is the full reduced room (rooms are small
 * and bounded), so a reconnecting viewer never has to replay a cursor; the
 * `id:` carries `last_seq` for debuggability only.
 */
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const viewer = resolvedViewer.context;

  let roomId: string;
  try {
    roomId = sanitizeDiscussionId((await context.params).id);
    const first = withViewerExecutionContext(viewer, () => readDiscussionRoom(roomId));
    if (!first) return new Response('discussion not found', { status: 404 });
    assertDiscussionVisible(viewer, first.scope);
  } catch (error) {
    return viewerErrorResponse(error);
  }

  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  let lastSent = '';
  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    if (ping) clearInterval(ping);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          close();
        }
      };
      const poll = () => {
        if (closed) return;
        const raw = withViewerExecutionContext(viewer, () => readDiscussionRoom(roomId));
        if (!raw) return;
        // The mission approval is decided elsewhere (no room event), so its live
        // status is part of what makes a frame new.
        const room = withLiveMissionStatus(raw);
        const signature = `${room.last_seq}:${room.outcomes.mission?.approval_status ?? ''}`;
        if (signature === lastSent) return;
        lastSent = signature;
        write(sse('state', room, room.last_seq));
        if (TERMINAL.has(room.status)) {
          write(sse('end', { status: room.status }));
          close();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };
      write('retry: 1500\n\n');
      poll();
      timer = setInterval(poll, 400);
      ping = setInterval(() => write(': keep-alive\n\n'), 15_000);
    },
    cancel() {
      close();
    },
  });
  req.signal.addEventListener('abort', close);

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
