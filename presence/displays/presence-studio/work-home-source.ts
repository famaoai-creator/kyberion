/** Thin read-only adapter. Each source keeps its own existing access boundary. */
import type express from 'express';
import { listApprovalRequests } from '@agent/core/governance/approval-store';
import { listArtifactRecords } from '@agent/core/workforce/artifact-record';
import { listTaskSessions } from '@agent/core/task/task-session';
import { readSurfaceStringParam } from '@agent/core/surface/surface-request-input';
import { frontDeskExecutionViewerFingerprint } from '@agent/core/surface/front-desk-execution-contract';
import {
  readFrontDeskConversationWork,
  presenceFrontDeskConversationViewer,
} from '@agent/core/surface/front-desk-conversation-store';
import {
  normalizeEventScope,
  parseEventScopeFromRecord,
  type EventScopeInput,
} from '@agent/core/event-scope';
import type { SurfaceViewerScope } from '@agent/core/surface/surface-mutation-guard';
import { normalizeLocale } from '@agent/core/locale-normalize';
import {
  PresenceStudioViewerError,
  resolvePresenceStudioViewerContext,
  narrowPresenceStudioScope,
  toFrontDeskViewerScope,
  requirePresenceStudioLocalAdmin,
} from './security.js';
import * as data from './presence-studio-runtime-data.js';
import { buildHomePayload } from './home.js';
import {
  buildWorkHomePayload,
  type WorkHomeSourceInput,
  type WorkHomeSourceId,
} from './work-home.js';

/** Visibility claims must agree across legacy and canonical envelopes. Unknown
 * tier is readable only by the local all-tier operator, never a remote token. */
export function workHomeRecordInScope(viewer: SurfaceViewerScope, value: unknown): boolean {
  const claims: Record<string, string> = {};
  const aliases: Record<string, string> = {
    tenantSlug: 'tenant_slug',
    tenantId: 'tenant_slug',
    tenant_id: 'tenant_slug',
    organizationId: 'organization_id',
    projectId: 'project_id',
  };
  const fields = new Set(['tier', 'tenant_slug', 'organization_id', 'project_id']);
  function collect(input: unknown, depth: number): boolean {
    if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 3) return false;
    const record = input as Record<string, unknown>;
    if (record.scope_kind !== undefined && parseEventScopeFromRecord(record).invalid) return false;
    for (const [rawKey, rawValue] of Object.entries(record)) {
      const key = aliases[rawKey] || rawKey;
      if (!fields.has(key) || rawValue === undefined) continue;
      if (typeof rawValue !== 'string' || !rawValue.trim() || rawValue !== rawValue.trim())
        return false;
      if (claims[key] !== undefined && claims[key] !== rawValue) return false;
      claims[key] = rawValue;
    }
    for (const key of [
      'scope',
      'scope_context',
      'project_context',
      'project',
      'context',
      'requestedByContext',
    ]) {
      if (record[key] !== undefined && !collect(record[key], depth + 1)) return false;
    }
    return true;
  }
  if (!collect(value, 0)) return false;
  if (!claims.tier && viewer.source !== 'loopback') return false;
  if (
    claims.tier &&
    !viewer.tierAccess.includes(claims.tier as 'public' | 'confidential' | 'personal')
  )
    return false;
  try {
    const normalized = normalizeEventScope(claims as EventScopeInput);
    return (
      (viewer.tenantSlugs === 'all' ||
        Boolean(normalized.tenant_slug && viewer.tenantSlugs.includes(normalized.tenant_slug))) &&
      (viewer.organizationIds === 'all' ||
        Boolean(
          normalized.organization_id && viewer.organizationIds.includes(normalized.organization_id)
        )) &&
      (viewer.projectIds === 'all' ||
        Boolean(normalized.project_id && viewer.projectIds.includes(normalized.project_id)))
    );
  } catch {
    return false;
  }
}

export function readWorkHome(req: express.Request) {
  const viewer = resolvePresenceStudioViewerContext(req);
  for (const key of ['tenant', 'organizationId', 'projectId']) {
    if (
      req.query[key] !== undefined &&
      (typeof req.query[key] !== 'string' || !String(req.query[key]).trim())
    ) {
      throw new PresenceStudioViewerError(403, 'Invalid scope selection.');
    }
  }
  const selection = {
    tenant: readSurfaceStringParam(req.query.tenant),
    organizationId: readSurfaceStringParam(req.query.organizationId),
    projectId: readSurfaceStringParam(req.query.projectId),
  };
  const scopedViewer = narrowPresenceStudioScope(viewer, selection);
  const scope = toFrontDeskViewerScope(scopedViewer);
  const scopeId = frontDeskExecutionViewerFingerprint(scope);
  const sources: Partial<Record<WorkHomeSourceId, WorkHomeSourceInput>> = {};
  function read<T>(id: WorkHomeSourceId, reader: () => T[], fallback: T[] = []): T[] {
    try {
      const result = reader();
      sources[id] = { state: 'available', total: result.length };
      return result;
    } catch {
      sources[id] = { state: 'unavailable' };
      return fallback;
    }
  }
  const approvals = read('approvals', () =>
    listApprovalRequests({ status: 'pending' })
      .filter((record) => workHomeRecordInScope(scope, record))
      .map((record) => ({
        id: record.id,
        title: record.title,
        when: record.requestedAt,
        tenant_slug: record.scope?.tenant_slug,
        scope_id: scopeId,
      }))
  );
  let heldSnapshotTruncated = false;
  const heldActions = read('held_actions', () => {
    const snapshot = data.cloudflareOsSurface.snapshot(undefined, viewer, {
      readOnly: true,
      includeObservations: false,
    });
    // Snapshot limits all statuses before pending filtering. A full window is
    // incomplete evidence even if no pending row remains in the window.
    heldSnapshotTruncated = snapshot.heldActions.length >= 50;
    return snapshot.heldActions
      .filter((item) => item.status === 'pending')
      .filter((item) => workHomeRecordInScope(scope, { tenant_slug: item.tenantSlug }))
      .map((item) => ({
        id: item.id,
        title: item.op || item.id,
        when: item.submittedAt,
        tenant_slug: item.tenantSlug,
        scope_id: scopeId,
      }));
  });
  if (heldSnapshotTruncated) sources.held_actions = { state: 'partial' };
  const taskSessions = read('task_sessions', () =>
    listTaskSessions('presence')
      .filter((session) => workHomeRecordInScope(scope, session))
      .map((session) => ({
        id: session.session_id,
        title: session.goal?.summary || session.session_id,
        status: session.status,
        when: session.updated_at,
        scope_id: scopeId,
        correlation_id: session.correlation_id,
        awaiting_user_input: session.control?.awaiting_user_input === true,
        // Raw history may include internal output paths; keep only typed status.
      }))
  );
  const artifacts = read('artifacts', () =>
    listArtifactRecords()
      .filter((record) => workHomeRecordInScope(scope, record))
      .map((record) => ({
        id: record.artifact_id,
        title: record.path?.replace(/\\/g, '/').split('/').filter(Boolean).pop() || record.kind,
        kind: record.kind,
        scope_id: scopeId,
      }))
  );
  const conversation = read('conversation', () => {
    // The home read endpoint accepts readonly remote tokens; the conversation
    // endpoint does not. Never turn aggregation into an authorization upgrade.
    requirePresenceStudioLocalAdmin(viewer);
    return readFrontDeskConversationWork(
      presenceFrontDeskConversationViewer(scope),
      normalizeLocale(req.query.locale) ?? 'en'
    ).tasks;
  });
  const now = new Date();
  const workHome = buildWorkHomePayload({
    now,
    scopeId,
    conversationWork: { sessionId: scopeId, tasks: conversation },
    approvals,
    heldActions,
    taskSessions,
    artifacts,
    sources,
  });
  // The narrowed selection is attached once, server-side. The client follows
  // these links unchanged instead of rewriting them from a mutable preference.
  function scopedHref(href: string): string {
    const url = new URL(href, 'http://work-home.invalid');
    for (const [key, value] of Object.entries(selection))
      if (value) url.searchParams.set(key, value);
    return url.pathname + url.search + url.hash;
  }
  const fullLocalWorkbench =
    viewer.source === 'loopback' &&
    scope.tenantSlugs === 'all' &&
    scope.organizationIds === 'all' &&
    scope.projectIds === 'all';
  for (const item of workHome.items) {
    if (!fullLocalWorkbench && (item.source === 'approval' || item.source === 'held_action')) {
      // The legacy decision workbench cannot preserve a narrower selection.
      // Keep the decision visible but never silently broaden its destination.
      item.links = [];
      item.next_step_key = 'front_desk:work_home_decision_scope_unavailable';
      item.resume.next_step_key = item.next_step_key;
    }
    for (const link of item.links) link.href = scopedHref(link.href);
  }
  return {
    ...buildHomePayload({ now, approvals, heldActions, taskSessions, artifacts }),
    work_home: workHome,
  };
}
