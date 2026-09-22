import { NextRequest } from 'next/server';
import { type EventScopeFilter } from '@agent/core/event-scope';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import { CollaborationEventBatcher } from '../../../../lib/collaboration-stream';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  viewerScopeTenantSlugs,
  withViewerExecutionContext,
} from '../../../../lib/viewer-context';
import { readChronosOptionalStringParam } from '../../../../lib/request-input';
import { readEvents } from './helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sse(eventName: string, data: unknown, id?: string): string {
  return `${id ? `id: ${id}\n` : ''}event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const encoder = new TextEncoder();
  const missionId = readChronosOptionalStringParam(req.nextUrl.searchParams.get('mission'));
  const scopeKind = readChronosOptionalStringParam(req.nextUrl.searchParams.get('scope_kind'));
  const allowedScopeKinds = new Set([
    'system',
    'tenant',
    'organization',
    'project',
    'mission',
    'task',
    'session',
  ]);
  const scopeFilter: Omit<EventScopeFilter, 'tenant_slug' | 'tenant_slugs'> = {
    ...(readChronosOptionalStringParam(req.nextUrl.searchParams.get('organization'))
      ? {
          organization_id: readChronosOptionalStringParam(
            req.nextUrl.searchParams.get('organization')
          )!,
        }
      : {}),
    ...(readChronosOptionalStringParam(req.nextUrl.searchParams.get('project'))
      ? { project_id: readChronosOptionalStringParam(req.nextUrl.searchParams.get('project'))! }
      : {}),
    ...(readChronosOptionalStringParam(req.nextUrl.searchParams.get('task'))
      ? { task_id: readChronosOptionalStringParam(req.nextUrl.searchParams.get('task'))! }
      : {}),
    ...(readChronosOptionalStringParam(req.nextUrl.searchParams.get('session'))
      ? { session_id: readChronosOptionalStringParam(req.nextUrl.searchParams.get('session'))! }
      : {}),
    ...(scopeKind && allowedScopeKinds.has(scopeKind)
      ? { scope_kind: scopeKind as EventScopeFilter['scope_kind'] }
      : {}),
  };
  let tenantSlugs: string[] | 'all';
  try {
    tenantSlugs = viewerScopeTenantSlugs(
      resolvedViewer.context,
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'))
    );
  } catch (error) {
    return viewerErrorResponse(error);
  }
  const tierAccess = resolvedViewer.context.tierAccess ?? ['public', 'confidential'];
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
        const result = withViewerExecutionContext(resolvedViewer.context, () =>
          readEvents(scanCursor, missionId, tenantSlugs, scopeFilter, tierAccess)
        );
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
