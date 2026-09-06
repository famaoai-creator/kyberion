import type { NextRequest } from 'next/server';
import { readConciergeHome } from '../../../lib/headless-projections';
import { readConciergeScopeQuery } from '../../../lib/request-input';
import { resolveConciergeViewer } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * CS-01: Server-Sent Events replacement for the 30-second summary polling.
 * Read-only (same data source as /api/summary), so no mutation guard.
 *
 * - Sends the current summary immediately on connect.
 * - Re-checks `buildCeoSurfaceSummary()` every 5 s and pushes a `summary`
 *   event only when the serialized payload actually changed.
 * - Emits a heartbeat comment every 25 s so proxies keep the stream open.
 * - Cleans up both intervals when the request is aborted.
 */
const SUMMARY_CHECK_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 25_000;

function summaryEventChunk(serialized: string): string {
  return `event: summary\ndata: ${serialized}\n\n`;
}

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const encoder = new TextEncoder();
  let previousPayload = '';
  let summaryTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const closeStream = () => {
    if (closed) return;
    closed = true;
    if (summaryTimer) {
      clearInterval(summaryTimer);
      summaryTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = () => {
        if (closed) return;
        let serialized: string;
        try {
          serialized = JSON.stringify(
            readConciergeHome(resolved.context, {
              ...readConciergeScopeQuery(req.nextUrl.searchParams),
            })
          );
        } catch (error) {
          console.warn(
            `[concierge] summary stream check failed: ${error instanceof Error ? error.message : String(error)}`
          );
          return;
        }
        if (serialized === previousPayload) return;
        previousPayload = serialized;
        try {
          controller.enqueue(encoder.encode(summaryEventChunk(serialized)));
        } catch {
          closeStream();
        }
      };

      try {
        controller.enqueue(encoder.encode('retry: 5000\n\n'));
      } catch {
        closeStream();
        return;
      }
      // Initial snapshot immediately, then change-detection every 5 s.
      push();
      summaryTimer = setInterval(push, SUMMARY_CHECK_INTERVAL_MS);
      heartbeatTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          closeStream();
        }
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      closeStream();
    },
  });

  req.signal.addEventListener('abort', closeStream);

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
