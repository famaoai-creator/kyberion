import path from 'node:path';
import { NextRequest } from 'next/server';
import { parseSafeJsonInput } from '@agent/core/foundation';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeReaddir,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
  eventScopeFromRecord,
  eventScopeMatches,
  parseEventScopeFromRecord,
  type EventScopeFilter,
} from '@agent/core/event-scope';
import { redactCollaborationMetadata } from '@agent/core/agent-collaboration-events';
import {
  workerEventEnvelopeSchema,
  type WorkerEventEnvelope,
} from '@agent/core/worker-event-stream';
import type { OsKnowledgeTier } from '@agent/core/cloudflare-os-control-plane';
import { listMissionsInSearchDirs, loadState } from '@agent/core/mission-state';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import {
  CollaborationEventBatcher,
  collaborationEventVisibleToTier,
  normalizeWorkerEvent,
  type CollaborationStreamEvent,
} from '../../../../lib/collaboration-stream';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  viewerScopeTenantSlugs,
  withViewerExecutionContext,
} from '../../../../lib/viewer-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sse(eventName: string, data: unknown, id?: string): string {
  return `${id ? `id: ${id}\n` : ''}event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function eventFiles(rootPath = pathResolver.shared('logs/worker-events')): string[] {
  try {
    const root = assertSafeRepositoryPath(rootPath, { allowMissingLeaf: true });
    if (!safeExistsSync(root) || !safeLstat(root).isDirectory()) return [];
    const files: string[] = [];
    const addRegularFile = (filePath: string): void => {
      try {
        const safeFile = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
        if (safeExistsSync(safeFile) && safeLstat(safeFile).isFile()) files.push(safeFile);
      } catch {
        // A symlink, malformed, or concurrently removed event resource is skipped.
      }
    };
    const rootEntries = safeReaddir(root);
    for (const entry of rootEntries) {
      if (/^worker-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry)) {
        addRegularFile(path.join(root, entry));
      }
    }
    for (const entry of rootEntries) {
      const missionDir = path.join(root, entry);
      try {
        const safeMissionDir = assertSafeRepositoryPath(missionDir, { allowMissingLeaf: true });
        if (!safeExistsSync(safeMissionDir) || !safeLstat(safeMissionDir).isDirectory()) continue;
        for (const file of safeReaddir(safeMissionDir)) {
          if (/^worker-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
            addRegularFile(path.join(safeMissionDir, file));
        }
      } catch {
        // A concurrently removed mission partition is harmless.
      }
    }
    return Array.from(new Set(files)).sort();
  } catch {
    return [];
  }
}

function readEvents(
  afterId: string | null,
  missionId?: string,
  tenantSlugs: string[] | 'all' = 'all',
  scopeFilter: Omit<EventScopeFilter, 'tenant_slug' | 'tenant_slugs'> = {},
  tierAccess: readonly OsKnowledgeTier[] = ['public', 'confidential']
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
        const event = workerEventEnvelopeSchema.parse(
          parseSafeJsonInput(line, 'collaboration event')
        ) as WorkerEventEnvelope;
        if (missionId && event.source?.mission_id !== missionId) continue;
        const normalized = normalizeWorkerEvent(event, id);
        const scopeResult = parseEventScopeFromRecord(normalized.payload);
        const normalizedScope = scopeResult.scope;
        if (scopeResult.invalid) continue;
        const eventScope = missionEventScope(normalized.mission_id);
        // Worker-event envelopes historically carried mission identity in
        // source but not the full scope in payload. Resolve that legacy form
        // from authoritative mission state; unknown tier is never exposed.
        if (!collaborationEventVisibleToTier(normalized.payload, eventScope?.tier, tierAccess))
          continue;
        if (tenantSlugs !== 'all') {
          const eventTenant =
            eventScope?.tenantSlug ||
            normalizedScope?.tenant_slug ||
            (typeof normalized.payload.tenant_slug === 'string'
              ? normalized.payload.tenant_slug
              : undefined);
          if (!eventTenant || !tenantSlugs.includes(eventTenant)) continue;
        }
        if (Object.keys(scopeFilter).length > 0 && !normalizedScope) continue;
        if (
          Object.keys(scopeFilter).length > 0 &&
          !eventScopeMatches(normalizedScope, {
            ...(tenantSlugs !== 'all' ? { tenant_slugs: tenantSlugs } : {}),
            ...scopeFilter,
          })
        )
          continue;
        events.push({
          ...normalized,
          payload: redactCollaborationMetadata(normalized.payload),
        });
      } catch {
        // Torn JSONL records are skipped; the next poll/reconnect can replay a
        // valid subsequent record without poisoning the stream.
      }
    }
  }
  // A browser can reconnect with a cursor from a rotated log file. In that
  // case replay the bounded tail instead of silently waiting forever for a
  // cursor that can no longer be found.
  if (afterId && !foundCursor)
    return readEvents(null, missionId, tenantSlugs, scopeFilter, tierAccess);
  return { events: events.slice(-60), lastSeenId };
}

function missionEventScope(
  missionId: string | undefined
): { tier: OsKnowledgeTier; tenantSlug?: string } | undefined {
  const normalized = String(missionId || '')
    .trim()
    .toUpperCase();
  if (!normalized) return undefined;
  try {
    const matches = listMissionsInSearchDirs().filter((entry) => entry.missionId === normalized);
    if (matches.length !== 1) return undefined;
    const missionPath = matches[0].missionPath;
    const state = loadState(normalized, { directories: [path.dirname(missionPath)] });
    const tier = state?.tier;
    if (tier !== 'personal' && tier !== 'confidential' && tier !== 'public') return undefined;
    const tenantSlug =
      typeof state?.tenant_slug === 'string'
        ? state.tenant_slug
        : typeof state?.tenant_id === 'string'
          ? state.tenant_id
          : undefined;
    return { tier, ...(tenantSlug ? { tenantSlug } : {}) };
  } catch {
    return undefined;
  }
}

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const encoder = new TextEncoder();
  const missionId = req.nextUrl.searchParams.get('mission') || undefined;
  const scopeKind = req.nextUrl.searchParams.get('scope_kind') || undefined;
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
    ...(req.nextUrl.searchParams.get('organization')
      ? { organization_id: req.nextUrl.searchParams.get('organization')! }
      : {}),
    ...(req.nextUrl.searchParams.get('project')
      ? { project_id: req.nextUrl.searchParams.get('project')! }
      : {}),
    ...(req.nextUrl.searchParams.get('task')
      ? { task_id: req.nextUrl.searchParams.get('task')! }
      : {}),
    ...(req.nextUrl.searchParams.get('session')
      ? { session_id: req.nextUrl.searchParams.get('session')! }
      : {}),
    ...(scopeKind && allowedScopeKinds.has(scopeKind)
      ? { scope_kind: scopeKind as EventScopeFilter['scope_kind'] }
      : {}),
  };
  let tenantSlugs: string[] | 'all';
  try {
    tenantSlugs = viewerScopeTenantSlugs(
      resolvedViewer.context,
      req.nextUrl.searchParams.get('tenant') || undefined
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
