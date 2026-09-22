import path from 'node:path';
import { readJsonLines } from '@agent/core/foundation';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
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
import {
  collaborationEventVisibleToTier,
  normalizeWorkerEvent,
  type CollaborationStreamEvent,
} from '../../../../lib/collaboration-stream';

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

export function readEvents(
  afterId: string | null,
  missionId?: string,
  tenantSlugs: string[] | 'all' = 'all',
  scopeFilter: Omit<EventScopeFilter, 'tenant_slug' | 'tenant_slugs'> = {},
  tierAccess: readonly OsKnowledgeTier[] = ['public', 'confidential'],
  files: readonly string[] = eventFiles()
): { events: CollaborationStreamEvent[]; lastSeenId?: string } {
  const events: CollaborationStreamEvent[] = [];
  let lastSeenId: string | undefined;
  let foundCursor = !afterId;
  for (const file of files) {
    const entries = readJsonLines<{ id: string; value: unknown }>(file, {
      map: (value, lineNumber) => ({
        id: `${file}:${lineNumber - 1}`,
        value,
      }),
      onMalformed: (_error, lineNumber) => {
        const id = `${file}:${lineNumber - 1}`;
        if (!foundCursor) {
          if (id === afterId) foundCursor = true;
          return;
        }
        lastSeenId = id;
      },
    });
    for (const { id, value } of entries) {
      if (!foundCursor) {
        if (id === afterId) foundCursor = true;
        continue;
      }
      lastSeenId = id;
      try {
        const event = workerEventEnvelopeSchema.parse(value) as WorkerEventEnvelope;
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
    return readEvents(null, missionId, tenantSlugs, scopeFilter, tierAccess, files);
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
