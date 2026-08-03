import path from 'node:path';
import { NextRequest } from 'next/server';
import {
  pathResolver,
  safeExistsSync,
  safeReadFile,
  safeReaddir,
  workerEventEnvelopeSchema,
  type WorkerEventEnvelope,
} from '@agent/core';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import {
  CollaborationEventBatcher,
  normalizeWorkerEvent,
  type CollaborationStreamEvent,
} from '../../../../lib/collaboration-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sse(eventName: string, data: unknown, id?: string): string {
  return `${id ? `id: ${id}\n` : ''}event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

function eventFiles(): string[] {
  const root = pathResolver.shared('logs/worker-events');
  if (!safeExistsSync(root)) return [];
  const files = safeReaddir(root)
    .filter((entry) => /^worker-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry))
    .map((entry) => path.join(root, entry));
  for (const entry of safeReaddir(root)) {
    const missionDir = path.join(root, entry);
    if (!safeExistsSync(missionDir)) continue;
    try {
      for (const file of safeReaddir(missionDir)) {
        if (/^worker-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
          files.push(path.join(missionDir, file));
      }
    } catch {
      // A concurrently removed mission partition is harmless.
    }
  }
  return Array.from(new Set(files)).sort();
}

function readEvents(
  afterId: string | null,
  missionId?: string
): { events: CollaborationStreamEvent[]; lastSeenId?: string } {
  const events: CollaborationStreamEvent[] = [];
  let lastSeenId: string | undefined;
  let foundCursor = !afterId;
  for (const file of eventFiles()) {
    const raw = String(safeReadFile(file, { encoding: 'utf8' }) || '');
    const lines = raw.split(/\r?\n/);
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
      const line = lines[lineNumber]?.trim();
      if (!line) continue;
      const id = `${file}:${lineNumber}`;
      if (!foundCursor) {
        if (id === afterId) foundCursor = true;
        continue;
      }
      lastSeenId = id;
      try {
        const event = workerEventEnvelopeSchema.parse(JSON.parse(line)) as WorkerEventEnvelope;
        if (missionId && event.source?.mission_id !== missionId) continue;
        events.push(normalizeWorkerEvent(event, id));
      } catch {
        // Torn JSONL records are skipped; the next poll/reconnect can replay a
        // valid subsequent record without poisoning the stream.
      }
    }
  }
  return { events: events.slice(-60), lastSeenId };
}

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;

  const encoder = new TextEncoder();
  const missionId = req.nextUrl.searchParams.get('mission') || undefined;
  const requestedCursor = req.headers.get('last-event-id');
  let cursor = requestedCursor;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  let scanCursor = requestedCursor;

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
      const batcher = new CollaborationEventBatcher((events) => {
        if (closed || events.length === 0) return;
        cursor = events[events.length - 1].id;
        write(sse(events.length === 1 ? events[0].type : 'batch', { events }, cursor));
      });
      const poll = () => {
        if (closed) return;
        const result = readEvents(scanCursor, missionId);
        if (result.lastSeenId) scanCursor = result.lastSeenId;
        for (const event of result.events) batcher.push(event);
      };
      write('retry: 1500\n\n');
      poll();
      timer = setInterval(poll, 500);
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
