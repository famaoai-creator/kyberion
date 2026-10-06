/** Durable transcript schema and request admission snapshots. No dispatch, results or status projection. */
import { createHash } from 'node:crypto';
import { withExecutionContext } from '../authority.js';
import { physicalScopedPath } from '../physical-namespace.js';
import {
  readGovernedArtifactJson,
  writeGovernedArtifactJson,
} from '../workforce/artifact-store.js';
import type { SurfaceViewerScope } from './surface-mutation-guard.js';
import type { EventScopeInput } from '../event-scope.js';
import { isFirstJobDiagnosticMapping } from './first-job-admission.js';
import {
  getFrontDeskExecutionMapping,
  frontDeskExecutionViewerMatches,
  isFrontDeskExecutionPublicViewer,
  parseFrontDeskExecutionBinding,
  frontDeskArtifactRevisionCommand,
  type FrontDeskExecutionBinding,
  type FrontDeskExecutionProjection,
} from './front-desk-execution-contract.js';
import {
  parseFrontDeskExecutionRecoveryReceipt,
  recoveryEvidenceHash,
  type FrontDeskExecutionRecoveryReceipt,
} from './front-desk-recovery-receipt.js';
import {
  parseConversationTaskState,
  parseConversationTaskDecision,
  CONVERSATION_TASK_MAX_TASKS,
  type ConversationTaskState,
  type ConversationTaskDecision,
} from './conversation-task-routing.js';
import {
  CONVERSATION_MAX_INPUT,
  CONVERSATION_MAX_REPLY,
  CONVERSATION_MAX_TURNS,
  ConversationStoreError,
} from './front-desk-conversation-history.js';

/** Server-owned authorization projection. No client identity/session can select a transcript. */
export type FrontDeskConversationViewer = SurfaceViewerScope;
export function frontDeskConversationScope(viewer: FrontDeskConversationViewer): EventScopeInput {
  const tenant =
    viewer.tenantSlugs !== 'all' && viewer.tenantSlugs.length === 1
      ? viewer.tenantSlugs[0]
      : undefined;
  const tier = viewer.tierAccess.includes('confidential')
    ? 'confidential'
    : viewer.tierAccess.includes('public')
      ? 'public'
      : undefined;
  return tenant && tier
    ? { scope_kind: 'tenant', tier, tenant_slug: tenant }
    : { scope_kind: 'system', tier: 'public' };
}

/** Presence's localadmin is the same server-local operator. Keep the existing
 * Concierge key unchanged and narrow away Presence-only personal access.
 * Never alias credential-backed or actual user principals. */
export function presenceFrontDeskConversationViewer(
  viewer: FrontDeskConversationViewer
): FrontDeskConversationViewer {
  if (viewer.source !== 'loopback' || viewer.principalId !== 'human:presence-studio-localadmin')
    return viewer;
  return {
    ...viewer,
    principalId: 'human:concierge-localadmin',
    tierAccess: viewer.tierAccess.filter((tier) => tier !== 'personal'),
  };
}
export type Turn = {
  id: string;
  text: string;
  createdAt: number;
  reply?: string;
  uncertain?: boolean;
  retryable?: boolean;
  requestDigest?: string;
  routing?: ConversationTaskDecision;
};
export type ReservedConversationTurn = {
  routing?: ConversationTaskDecision;
  id: string;
  created: boolean;
  reply?: string;
  uncertain?: boolean;
};
export const PENDING_RETENTION_MS = 24 * 60 * 60 * 1000;
export type Transcript = {
  version: 2 | 3 | 4 | 5;
  sessionId: string;
  turns: Turn[];
  taskState?: ConversationTaskState;
  droppedRequests?: Array<{ id: string; createdAt: number }>;
  executionRequests?: FrontDeskExecutionRequest[];
  executionReports?: FrontDeskExecutionReport[];
};
export interface FrontDeskExecutionRequest {
  binding: FrontDeskExecutionBinding;
  viewer: FrontDeskConversationViewer;
  sessionId: string;
  revision: number;
  requestDigest: string;
  status: 'pending' | 'invalidated' | 'cancel_requested' | 'terminated_unstarted';
  recoveryReceipt?: FrontDeskExecutionRecoveryReceipt;
  createdAt: number;
}
export interface FrontDeskExecutionReport {
  id: string;
  requestId: string;
  status: FrontDeskExecutionProjection['status'];
  text: string;
  createdAt: number;
}
export const MAX_DROPPED_REQUESTS = 1024;
export const CONVERSATION_RETRY_WINDOW_MS = PENDING_RETENTION_MS;

function canonicalScope(value: string[] | 'all'): string[] | 'all' {
  return value === 'all' ? value : [...new Set(value)].sort();
}

/** The principal and every authorization restriction come from the server. */
export function conversationRef(viewer: FrontDeskConversationViewer) {
  if (viewer.source === 'anonymous' || !viewer.principalId?.trim()) {
    throw new ConversationStoreError('identity_required');
  }
  const scope = frontDeskConversationScope(viewer);
  const key = createHash('sha256')
    .update(
      JSON.stringify({
        principal: viewer.principalId,
        member: viewer.memberId ?? null,
        source: viewer.source,
        role: viewer.role,
        tenants: canonicalScope(viewer.tenantSlugs),
        organizations: canonicalScope(viewer.organizationIds),
        projects: canonicalScope(viewer.projectIds),
        tiers: canonicalScope(viewer.tierAccess),
        scope,
      })
    )
    .digest('hex');
  return {
    sessionId: `concierge-${key}`,
    key,
    scope,
    path: physicalScopedPath(
      'active/shared/coordination/channels/concierge/conversations',
      scope,
      `${key}.json`
    ),
  };
}

export function asStore<T>(viewer: FrontDeskConversationViewer, fn: () => T): T {
  const scope = frontDeskConversationScope(viewer);
  return withExecutionContext('sovereign_concierge', fn, undefined, scope.tenant_slug);
}

export function validText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}

export function load(ref: ReturnType<typeof conversationRef>): Transcript {
  const value = readGovernedArtifactJson<unknown>(ref.path);
  if (value === null)
    return { version: 2, sessionId: ref.sessionId, turns: [], taskState: { tasks: [] } };
  if (!value || typeof value !== 'object') throw new ConversationStoreError('invalid_history');
  const record = value as Record<string, unknown>;
  if (
    (record.version !== 1 &&
      record.version !== 2 &&
      record.version !== 3 &&
      record.version !== 4 &&
      record.version !== 5) ||
    ((record.version === 2 ||
      record.version === 3 ||
      record.version === 4 ||
      record.version === 5) &&
      record.taskState === undefined) ||
    record.sessionId !== ref.sessionId ||
    !Array.isArray(record.turns) ||
    record.turns.length > CONVERSATION_MAX_TURNS
  ) {
    throw new ConversationStoreError('invalid_history');
  }
  const ids = new Set<string>();
  const turns: Turn[] = record.turns.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new ConversationStoreError('invalid_history');
    const turn = value as Record<string, unknown>;
    if (
      typeof turn.id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(turn.id) ||
      ids.has(turn.id) ||
      !validText(turn.text, CONVERSATION_MAX_INPUT) ||
      typeof turn.createdAt !== 'number' ||
      !Number.isFinite(turn.createdAt) ||
      turn.createdAt < 0 ||
      (turn.reply !== undefined && !validText(turn.reply, CONVERSATION_MAX_REPLY)) ||
      (turn.uncertain !== undefined && typeof turn.uncertain !== 'boolean') ||
      (turn.retryable !== undefined && typeof turn.retryable !== 'boolean') ||
      (turn.requestDigest !== undefined &&
        (typeof turn.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(turn.requestDigest)))
    ) {
      throw new ConversationStoreError('invalid_history');
    }
    const routing =
      turn.routing === undefined ? undefined : parseConversationTaskDecision(turn.routing);
    if (turn.routing !== undefined && !routing) throw new ConversationStoreError('invalid_history');
    ids.add(turn.id);
    return {
      ...(routing ? { routing } : {}),
      id: turn.id,
      text: turn.text,
      createdAt: turn.createdAt,
      ...(typeof turn.reply === 'string' ? { reply: turn.reply } : {}),
      ...(typeof turn.uncertain === 'boolean' ? { uncertain: turn.uncertain } : {}),
      ...(typeof turn.retryable === 'boolean' ? { retryable: turn.retryable } : {}),
      ...(typeof turn.requestDigest === 'string' ? { requestDigest: turn.requestDigest } : {}),
    };
  });
  const taskState =
    record.taskState === undefined ? { tasks: [] } : parseConversationTaskState(record.taskState);
  if (!taskState) throw new ConversationStoreError('invalid_history');
  const taskIds = new Set(taskState.tasks.map((task) => task.id));
  if (turns.some((turn) => turn.routing?.taskIds.some((id) => !taskIds.has(id))))
    throw new ConversationStoreError('invalid_history');
  const dropped = record.droppedRequests ?? [];
  if (
    !Array.isArray(dropped) ||
    dropped.length > MAX_DROPPED_REQUESTS ||
    dropped.some(
      (entry) =>
        !entry ||
        typeof entry !== 'object' ||
        typeof entry.id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(entry.id) ||
        typeof entry.createdAt !== 'number' ||
        !Number.isFinite(entry.createdAt)
    )
  )
    throw new ConversationStoreError('invalid_history');
  return {
    version: record.version === 5 ? 5 : record.version === 4 ? 4 : record.version === 3 ? 3 : 2,
    sessionId: ref.sessionId,
    turns,
    taskState,
    droppedRequests: dropped.map((entry) => ({ id: entry.id, createdAt: entry.createdAt })),
    executionRequests: parseExecutionRequests(record.executionRequests, ref, taskState),
    executionReports: parseExecutionReports(record.executionReports),
  };
}

/** All publications share this version fence. Legacy v2 writers reject durable
 * v3 work; legacy v3 writers reject v4 lineage rather than silently discard it. */
export function publishTranscript(
  ref: ReturnType<typeof conversationRef>,
  transcript: Transcript
): void {
  if (
    transcript.version === 5 ||
    transcript.executionRequests?.some((request) => request.recoveryReceipt)
  )
    transcript.version = 5;
  else if (
    transcript.version === 4 ||
    transcript.executionRequests?.some((request) => request.binding.parent_request_id)
  )
    transcript.version = 4;
  else if (
    transcript.version === 3 ||
    (transcript.executionRequests?.length ?? 0) > 0 ||
    (transcript.executionReports?.length ?? 0) > 0
  )
    transcript.version = 3;
  writeGovernedArtifactJson('sovereign_concierge', ref.path, transcript);
}

/** Execution requires representable singular restrictions. The legacy storage
 * scope/hash above is unchanged; a hash is never a substitute for authorization. */
export function frontDeskRuntimeScope(viewer: FrontDeskConversationViewer): EventScopeInput {
  if (viewer.source === 'anonymous' || !viewer.principalId?.trim())
    throw new ConversationStoreError('identity_required');
  for (const allowed of [viewer.tenantSlugs, viewer.organizationIds, viewer.projectIds]) {
    if (allowed !== 'all' && allowed.length !== 1)
      throw new ConversationStoreError('scope_selection_required');
  }
  const scope = frontDeskConversationScope(viewer);
  const organizationId = viewer.organizationIds === 'all' ? undefined : viewer.organizationIds[0];
  const projectId = viewer.projectIds === 'all' ? undefined : viewer.projectIds[0];
  if ((organizationId && !scope.tenant_slug) || (projectId && !organizationId))
    throw new ConversationStoreError('scope_selection_required');
  return {
    ...scope,
    viewer_principal: viewer.principalId,
    scope_kind: projectId ? 'project' : organizationId ? 'organization' : scope.scope_kind,
    ...(organizationId ? { organization_id: organizationId } : {}),
    ...(projectId ? { project_id: projectId } : {}),
  };
}

function objectValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function validExecutionViewer(value: unknown): value is FrontDeskConversationViewer {
  if (
    !objectValue(value) ||
    !['token', 'loopback'].includes(String(value.source)) ||
    !['localadmin', 'readonly'].includes(String(value.role)) ||
    !validText(value.principalId, 256) ||
    (value.memberId !== undefined && !validText(value.memberId, 256))
  )
    return false;
  for (const key of ['tenantSlugs', 'organizationIds', 'projectIds', 'tierAccess']) {
    const values = value[key];
    if (values === 'all' && key !== 'tierAccess') continue;
    if (
      !Array.isArray(values) ||
      values.length > 64 ||
      !values.every((entry) => validText(entry, 256))
    )
      return false;
  }
  return (value.tierAccess as string[]).every((tier) =>
    ['public', 'confidential', 'personal'].includes(tier)
  );
}
function parseExecutionRequests(
  value: unknown,
  ref: ReturnType<typeof conversationRef>,
  state: ConversationTaskState
): FrontDeskExecutionRequest[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CONVERSATION_TASK_MAX_TASKS)
    throw new ConversationStoreError('invalid_history');
  const ids = new Set<string>();
  return value.map((row) => {
    if (
      !objectValue(row) ||
      Object.keys(row).some(
        (key) =>
          ![
            'binding',
            'viewer',
            'sessionId',
            'revision',
            'requestDigest',
            'status',
            'createdAt',
            'recoveryReceipt',
          ].includes(key)
      )
    )
      throw new ConversationStoreError('invalid_history');
    const binding = parseFrontDeskExecutionBinding(row.binding);
    if (
      !binding ||
      !validExecutionViewer(row.viewer) ||
      row.sessionId !== ref.sessionId ||
      binding.conversation_key !== ref.key ||
      conversationRef(row.viewer).key !== ref.key ||
      !Number.isSafeInteger(row.revision) ||
      (row.revision as number) < binding.revision ||
      typeof row.requestDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.requestDigest) ||
      !['pending', 'invalidated', 'cancel_requested', 'terminated_unstarted'].includes(
        String(row.status)
      ) ||
      typeof row.createdAt !== 'number' ||
      !Number.isFinite(row.createdAt) ||
      row.createdAt < 0 ||
      !state.tasks.some(
        (task) => task.id === binding.request_id && task.workItemId === binding.work_item_id
      ) ||
      ids.has(binding.request_id)
    )
      throw new ConversationStoreError('invalid_history');
    const recoveryReceipt =
      row.recoveryReceipt === undefined
        ? undefined
        : parseFrontDeskExecutionRecoveryReceipt(row.recoveryReceipt);
    if (
      (row.recoveryReceipt !== undefined && !recoveryReceipt) ||
      (row.status === 'terminated_unstarted') !== Boolean(recoveryReceipt) ||
      (recoveryReceipt &&
        recoveryEvidenceHash(recoveryReceipt.binding) !== recoveryEvidenceHash(binding))
    )
      throw new ConversationStoreError('invalid_history');
    ids.add(binding.request_id);
    return {
      binding,
      viewer: structuredClone(row.viewer),
      sessionId: ref.sessionId,
      revision: row.revision as number,
      requestDigest: row.requestDigest,
      status: row.status as FrontDeskExecutionRequest['status'],
      ...(recoveryReceipt ? { recoveryReceipt } : {}),
      createdAt: row.createdAt,
    };
  });
}
function parseExecutionReports(value: unknown): FrontDeskExecutionReport[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CONVERSATION_TASK_MAX_TASKS)
    throw new ConversationStoreError('invalid_history');
  const ids = new Set<string>();
  const parsed = value.map((row) => {
    if (
      !objectValue(row) ||
      Object.keys(row).some(
        (key) => !['id', 'requestId', 'status', 'text', 'createdAt'].includes(key)
      ) ||
      !validText(row.id, 256) ||
      ids.has(row.id) ||
      typeof row.requestId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(row.requestId) ||
      ![
        'queued',
        'awaiting_approval',
        'running',
        'work_completed',
        'blocked',
        'cancel_requested',
        'uncertain',
        'terminated_unstarted',
      ].includes(String(row.status)) ||
      !validText(row.text, CONVERSATION_MAX_REPLY) ||
      typeof row.createdAt !== 'number' ||
      !Number.isFinite(row.createdAt) ||
      row.createdAt < 0
    )
      throw new ConversationStoreError('invalid_history');
    ids.add(row.id);
    return {
      id: row.id,
      requestId: row.requestId,
      status: row.status as FrontDeskExecutionProjection['status'],
      text: row.text,
      createdAt: row.createdAt,
    };
  });
  // Earlier receipts could append a correction for the same request. The last
  // persisted row is its latest projection; retain one bounded slot per request.
  return [...new Map(parsed.map((report) => [report.requestId, report])).values()];
}
/** Exact transcript snapshot, no lock, synchronization, or publication. */
export function readFrontDeskExecutionRecovery(
  binding: FrontDeskExecutionBinding
): FrontDeskExecutionRequest {
  const mapping = getFrontDeskExecutionMapping(binding);
  if (!mapping || !isFrontDeskExecutionPublicViewer(mapping.viewer))
    throw new Error('recovery_mapping_unavailable');
  const ref = conversationRef(mapping.viewer);
  if (binding.conversation_key !== ref.key) throw new Error('recovery_conversation_mismatch');
  return asStore(mapping.viewer, () => {
    const request = load(ref).executionRequests?.find(
      (row) => row.binding.request_id === binding.request_id
    );
    if (
      !request ||
      recoveryEvidenceHash(request.binding) !== recoveryEvidenceHash(binding) ||
      !frontDeskExecutionViewerMatches(request.viewer, mapping) ||
      request.sessionId !== ref.sessionId
    )
      throw new Error('recovery_request_unavailable');
    return structuredClone(request);
  });
}
export function inspectFrontDeskPendingRequest(
  binding: FrontDeskExecutionBinding,
  charter: {
    dot_id: string;
    status: string;
    runtime?: { execution_mode?: string };
    scope: {
      tier: 'public' | 'confidential' | 'personal';
      tenant_slug?: string;
      organization_id?: string;
      project_id?: string;
    };
  },
  _options: { rootDir?: string } = {}
) {
  const blocked = (reason: string) => ({ ok: false as const, reason });
  const mapping = getFrontDeskExecutionMapping(binding);
  if (!mapping) return blocked('configuration_changed');
  if (
    binding.diagnostic_protocol !== undefined &&
    (charter.runtime?.execution_mode !== 'front_desk_diagnostic' ||
      !isFirstJobDiagnosticMapping(mapping))
  )
    return blocked('diagnostic_provenance_requires_active_mode');
  if (!isFrontDeskExecutionPublicViewer(mapping.viewer)) return blocked('protected_scope');
  if (charter.dot_id !== mapping.dotId || charter.status !== 'active')
    return blocked('dot_unavailable');
  try {
    const scope = frontDeskRuntimeScope(mapping.viewer);
    if (
      charter.scope.tier !== scope.tier ||
      charter.scope.tenant_slug !== scope.tenant_slug ||
      charter.scope.organization_id !== scope.organization_id ||
      charter.scope.project_id !== scope.project_id
    )
      return blocked('scope_mismatch');
    const ref = conversationRef(mapping.viewer);
    if (binding.conversation_key !== ref.key) return blocked('conversation_mismatch');
    return asStore(mapping.viewer, () => {
      const transcript = load(ref);
      const request = transcript.executionRequests?.find(
        (entry) => entry.binding.request_id === binding.request_id
      );
      if (
        !request ||
        request.binding.diagnostic_protocol !== binding.diagnostic_protocol ||
        (Object.keys(binding) as Array<keyof FrontDeskExecutionBinding>).some(
          (key) => request.binding[key] !== binding[key]
        )
      )
        return blocked('request_mismatch');
      if (
        !frontDeskExecutionViewerMatches(request.viewer, mapping) ||
        request.sessionId !== ref.sessionId
      )
        return blocked('viewer_mismatch');
      if (request.status !== 'pending') return blocked(request.status);
      if (request.revision !== binding.revision || request.requestDigest !== binding.request_digest)
        return blocked('revision_changed');
      const task = transcript.taskState?.tasks.find((entry) => entry.id === binding.request_id);
      if (
        !task ||
        task.workItemId !== binding.work_item_id ||
        task.requestText !==
          (binding.receipt_format
            ? frontDeskArtifactRevisionCommand(binding.receipt_format)
            : mapping.exactCommand) ||
        task.updates.length !== 0 ||
        (!binding.parent_request_id &&
          createHash('sha256').update(task.requestText).digest('hex') !== binding.request_digest)
      )
        return blocked('request_changed');
      if (binding.parent_request_id) {
        const parent = transcript.executionRequests?.find(
          (entry) => entry.binding.request_id === binding.parent_request_id
        );
        if (
          !parent ||
          parent.status !== 'pending' ||
          parent.binding.revision !== binding.parent_revision ||
          parent.revision !== binding.parent_revision ||
          parent.binding.config_digest !== binding.config_digest
        )
          return blocked('parent_revision_changed');
      }
      return {
        ok: true as const,
        mapping,
        request,
        task,
        transcript,
      };
    });
  } catch {
    return blocked('request_unavailable');
  }
}
