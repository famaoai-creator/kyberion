import { createHash, randomUUID } from 'node:crypto';
import {
  loadFrontDeskExecutionPolicy,
  frontDeskMappingDigest,
  getFrontDeskExecutionMapping,
  frontDeskExecutionViewerMatches,
  isFrontDeskExecutionPublicViewer,
  parseFrontDeskExecutionBinding,
  frontDeskExecutionArtifactPath,
  frontDeskExecutionExpectedContent,
  type FrontDeskExecutionBinding,
  type FrontDeskExecutionMapping,
  type FrontDeskExecutionProjection,
} from './front-desk-execution-contract.js';
import { projectFrontDeskExecution } from './front-desk-execution-status.js';
import { withExecutionContext } from '../authority.js';
import { withLockSync } from '../lock-utils.js';
import { physicalScopedPath } from '../physical-namespace.js';
import { redactSensitiveString } from '../network.js';
import {
  readGovernedArtifactJson,
  writeGovernedArtifactJson,
} from '../workforce/artifact-store.js';
import { narrowSurfaceViewerScope, type SurfaceViewerScope } from './surface-mutation-guard.js';
import type { EventScopeInput } from '../event-scope.js';
import type { SupportedLocale } from '../locale-normalize.js';
import { t } from '../t.js';
import {
  applyConversationTurnOutcome,
  routeConversationTaskTurn,
  parseConversationTaskState,
  parseConversationTaskDecision,
  CONVERSATION_TASK_MAX_TASKS,
  type ConversationTaskState,
  type ConversationTaskDecision,
  type ConversationTurnOutcome,
} from './conversation-task-routing.js';
export {
  classifyConversationTurnOutcome,
  type ConversationTurnOutcome,
} from './conversation-task-routing.js';

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
import {
  CONVERSATION_MAX_INPUT,
  CONVERSATION_MAX_REPLY,
  CONVERSATION_MAX_TURNS,
  type ConversationHistory,
} from './front-desk-conversation-history.js';

type Turn = {
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
const PENDING_RETENTION_MS = 24 * 60 * 60 * 1000;
type Transcript = {
  version: 2 | 3;
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
  status: 'pending' | 'invalidated' | 'cancel_requested';
  createdAt: number;
}
export interface FrontDeskExecutionReport {
  id: string;
  requestId: string;
  status: FrontDeskExecutionProjection['status'];
  text: string;
  createdAt: number;
}
const MAX_DROPPED_REQUESTS = 1024;
export const CONVERSATION_RETRY_WINDOW_MS = PENDING_RETENTION_MS;

export class ConversationStoreError extends Error {
  constructor(
    public readonly code:
      | 'identity_required'
      | 'invalid_history'
      | 'invalid_text'
      | 'request_conflict'
      | 'request_expired'
      | 'scope_selection_required'
  ) {
    super(code);
  }
}

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

function asStore<T>(viewer: FrontDeskConversationViewer, fn: () => T): T {
  const scope = frontDeskConversationScope(viewer);
  return withExecutionContext('sovereign_concierge', fn, undefined, scope.tenant_slug);
}

function validText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}

function load(ref: ReturnType<typeof conversationRef>): Transcript {
  const value = readGovernedArtifactJson<unknown>(ref.path);
  if (value === null)
    return { version: 2, sessionId: ref.sessionId, turns: [], taskState: { tasks: [] } };
  if (!value || typeof value !== 'object') throw new ConversationStoreError('invalid_history');
  const record = value as Record<string, unknown>;
  if (
    (record.version !== 1 && record.version !== 2 && record.version !== 3) ||
    ((record.version === 2 || record.version === 3) && record.taskState === undefined) ||
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
    version: record.version === 3 ? 3 : 2,
    sessionId: ref.sessionId,
    turns,
    taskState,
    droppedRequests: dropped.map((entry) => ({ id: entry.id, createdAt: entry.createdAt })),
    executionRequests: parseExecutionRequests(record.executionRequests, ref, taskState),
    executionReports: parseExecutionReports(record.executionReports),
  };
}

/** All publications share this version fence. A legacy v2 front desk rejects
 * v3 before it can rewrite the transcript and silently discard durable work. */
function publishTranscript(ref: ReturnType<typeof conversationRef>, transcript: Transcript): void {
  if (
    transcript.version === 3 ||
    (transcript.executionRequests?.length ?? 0) > 0 ||
    (transcript.executionReports?.length ?? 0) > 0
  )
    transcript.version = 3;
  writeGovernedArtifactJson('sovereign_concierge', ref.path, transcript);
}

/** Known/registered credentials are redacted; arbitrary passwords cannot be inferred. */
function storedText(text: string, limit: number): string {
  return (
    redactSensitiveString(text)
      .replace(
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
        '[REDACTED_SECRET]'
      )
      .replace(
        /\b(password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
        '$1=[REDACTED_SECRET]'
      )
      // Redaction can expand short credentials. Bound the persisted projection,
      // after every secret has been removed, so it remains readable by load().
      .slice(0, limit)
  );
}

export function readConversationHistory(viewer: FrontDeskConversationViewer): ConversationHistory {
  const ref = conversationRef(viewer);
  return asStore(viewer, () =>
    withLockSync(`concierge-history-${ref.key}`, () => {
      const transcript = load(ref);
      if (syncExecutionReports(viewer, transcript)) publishTranscript(ref, transcript);
      const messages = transcript.turns.flatMap((turn) => [
        {
          id: `${turn.id}-user`,
          role: 'user' as const,
          createdAt: turn.createdAt,
          text: storedText(turn.text, CONVERSATION_MAX_INPUT),
        },
        ...(turn.reply === undefined
          ? []
          : [
              {
                id: `${turn.id}-secretary`,
                role: 'secretary' as const,
                createdAt: turn.createdAt,
                text: storedText(turn.reply, CONVERSATION_MAX_REPLY),
              },
            ]),
      ]);
      for (const report of transcript.executionReports ?? [])
        messages.push({
          id: report.id,
          role: 'secretary',
          createdAt: report.createdAt,
          text: storedText(report.text, CONVERSATION_MAX_REPLY),
        });
      messages.sort((a, b) => a.createdAt - b.createdAt);
      return {
        sessionId: ref.sessionId,
        pending: transcript.turns.filter((turn) => turn.reply === undefined && !turn.retryable)
          .length,
        messages: messages.slice(-CONVERSATION_MAX_TURNS * 2),
      };
    })
  );
}

export function beginConversationTurn(viewer: FrontDeskConversationViewer, text: string): string {
  return reserveConversationTurn(viewer, text).id;
}

/** Atomically reserve before execution. Retries only read their existing turn.
 * Keeping request IDs inside the server-owned transcript prevents cross-owner replay. */
export function reserveConversationTurn(
  viewer: FrontDeskConversationViewer,
  text: string,
  requestId: string = randomUUID(),
  requestCreatedAt = Date.now(),
  locale?: SupportedLocale
): ReservedConversationTurn {
  if (
    !Number.isFinite(requestCreatedAt) ||
    requestCreatedAt > Date.now() + 60_000 ||
    Date.now() - requestCreatedAt >= CONVERSATION_RETRY_WINDOW_MS
  )
    throw new ConversationStoreError('request_expired');
  // New reservations must satisfy both transcript and executable-binding identity contracts.
  // The loader deliberately retains its older permissive ID check for inert legacy history.
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId))
    throw new ConversationStoreError('invalid_text');
  if (!validText(text, CONVERSATION_MAX_INPUT)) throw new ConversationStoreError('invalid_text');
  const ref = conversationRef(viewer);
  return asStore(viewer, () =>
    withLockSync(`concierge-history-${ref.key}`, () => {
      const transcript = load(ref);
      transcript.droppedRequests = (transcript.droppedRequests ?? []).filter(
        (entry) => Date.now() - entry.createdAt < CONVERSATION_RETRY_WINDOW_MS
      );
      if (transcript.droppedRequests.some((entry) => entry.id === requestId))
        throw new ConversationStoreError('request_conflict');
      const existing = transcript.turns.find((turn) => turn.id === requestId);
      if (existing) {
        // Legacy turns have no digest: only their exact stored display text can
        // replay. New turns bind the full input before redaction or truncation.
        const matches = existing.requestDigest
          ? existing.requestDigest === createHash('sha256').update(text).digest('hex')
          : existing.text === text;
        if (!matches) throw new ConversationStoreError('request_conflict');
        if (existing.retryable && !existing.uncertain && existing.reply === undefined) {
          delete existing.retryable;
          publishTranscript(ref, transcript);
          return { id: existing.id, created: true, routing: existing.routing };
        }
        return {
          id: existing.id,
          created: false,
          reply: existing.reply,
          uncertain: existing.uncertain,
          routing: existing.routing,
        };
      }
      // Executable request identity outlives display turns and their retry tombstones.
      // A fresh timestamp must never recreate or reset an already bound task/revision.
      if (transcript.executionRequests?.some((entry) => entry.binding.request_id === requestId))
        throw new ConversationStoreError('request_conflict');
      const id = requestId;
      // Do not evict a pending turn that another process is still completing.
      if (transcript.turns.length === CONVERSATION_MAX_TURNS) {
        const completed = transcript.turns.findIndex(
          (turn) => turn.reply !== undefined || Date.now() - turn.createdAt >= PENDING_RETENTION_MS
        );
        if (completed < 0) throw new ConversationStoreError('invalid_history');
        const dropped = transcript.turns[completed];
        if (Date.now() - dropped.createdAt < CONVERSATION_RETRY_WINDOW_MS) {
          if (transcript.droppedRequests.length >= MAX_DROPPED_REQUESTS)
            throw new ConversationStoreError('invalid_history');
          transcript.droppedRequests.push({ id: dropped.id, createdAt: dropped.createdAt });
        }
        transcript.turns.splice(completed, 1);
      }
      // Intake classification is advisory only. Bind to this server-owned partition,
      // never to global TaskSession state or text recovered from old assistant replies.
      let routed = routeConversationTaskTurn(
        transcript.taskState ?? { tasks: [] },
        storedText(text, CONVERSATION_MAX_INPUT),
        id,
        Date.now(),
        locale
      );
      // Only this exact configured diagnostic command reserves executable work.
      // The request, outbox reference and queued answer share this one atomic write.
      const admission = executionAdmission(viewer, text, id, ref, routed.state, locale);
      if (admission) {
        routed = admission.routed;
        transcript.executionRequests = [...(transcript.executionRequests ?? []), admission.request];
      } else {
        const request = transcript.executionRequests?.find(
          (entry) => entry.binding.request_id === routed.decision.taskIds[0]
        );
        if (
          request &&
          (routed.decision.kind === 'followup' || routed.decision.kind === 'cancellation')
        ) {
          request.revision += 1;
          request.status =
            routed.decision.kind === 'cancellation' ? 'cancel_requested' : 'invalidated';
          request.requestDigest = createHash('sha256')
            .update(JSON.stringify({ previous: request.requestDigest, text }))
            .digest('hex');
          if (routed.decision.kind === 'cancellation') {
            routed.decision.reply = t('front_desk:execution_cancel_requested', undefined, locale);
          }
        }
        if (request && routed.decision.kind === 'status')
          routed.decision.reply =
            executionProjection(viewer, request, locale)?.text ?? routed.decision.reply;
      }
      syncExecutionReports(viewer, transcript);
      // Validate before publication too: a generated oversized/malformed reply must
      // never poison the durable transcript and make every subsequent read fail.
      if (
        !parseConversationTaskState(routed.state) ||
        !parseConversationTaskDecision(routed.decision)
      )
        throw new ConversationStoreError('invalid_history');
      transcript.taskState = routed.state;
      transcript.turns.push({
        routing: routed.decision,
        // Pure intake replies have no external execution. Publish their known
        // result atomically, so a crash cannot strand a replay as pending.
        ...(routed.decision.reply ? { reply: routed.decision.reply } : {}),
        id,
        text: storedText(text, CONVERSATION_MAX_INPUT),
        createdAt: Date.now(),
        requestDigest: createHash('sha256').update(text).digest('hex'),
      });
      publishTranscript(ref, transcript);
      return { id, created: true, routing: routed.decision };
    })
  );
}

/** `outcome` comes from the runtime's structured result, never from reply text;
 * omit it when the reply did not come from the conversation runtime. */
export function completeConversationTurn(
  viewer: FrontDeskConversationViewer,
  id: string,
  reply: string,
  outcome?: ConversationTurnOutcome
): void {
  if (!validText(reply, CONVERSATION_MAX_REPLY)) throw new ConversationStoreError('invalid_text');
  const ref = conversationRef(viewer);
  asStore(viewer, () =>
    withLockSync(`concierge-history-${ref.key}`, () => {
      const transcript = load(ref);
      const turn = transcript.turns.find((entry) => entry.id === id);
      const boundedReply = storedText(reply, CONVERSATION_MAX_REPLY);
      if (
        turn?.routing?.reply &&
        turn.reply === boundedReply &&
        turn.routing.reply === boundedReply
      )
        return; // The inert intake result was already committed by reservation.
      if (!turn || turn.reply !== undefined) throw new ConversationStoreError('invalid_history');
      turn.reply = boundedReply;
      delete turn.uncertain;
      delete turn.retryable;
      const taskId = turn.routing?.taskIds[0];
      if (
        outcome &&
        taskId &&
        (turn.routing?.kind === 'new_request' || turn.routing?.kind === 'followup')
      ) {
        transcript.taskState = applyConversationTurnOutcome(
          transcript.taskState ?? { tasks: [] },
          taskId,
          outcome,
          id,
          boundedReply,
          Date.now()
        );
      }
      publishTranscript(ref, transcript);
    })
  );
}

/** Execution failure may have occurred after a side effect. Never turn it into
 * a success reply, remove the request, or automatically replay it. */
export function markConversationTurnUncertain(
  viewer: FrontDeskConversationViewer,
  id: string
): void {
  const ref = conversationRef(viewer);
  asStore(viewer, () =>
    withLockSync(`concierge-history-${ref.key}`, () => {
      const transcript = load(ref);
      const turn = transcript.turns.find((entry) => entry.id === id);
      if (!turn || turn.reply !== undefined) throw new ConversationStoreError('invalid_history');
      turn.uncertain = true;
      delete turn.retryable;
      publishTranscript(ref, transcript);
    })
  );
}

/** A bounded, display-only context projection for a fresh scoped model turn.
 * Pending requests are deliberately absent: restoring context must not retry
 * uncertain work or reactivate old approval metadata. */
export function completedConversationContext(viewer: FrontDeskConversationViewer): {
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  truncated: boolean;
} {
  const history = readConversationHistory(viewer);
  const replies = new Map(
    history.messages
      .filter((message) => message.role === 'secretary')
      .map((message) => [message.id, message.text])
  );
  const pairs = history.messages
    .filter((message) => message.role === 'user')
    .flatMap((user) => {
      const reply = replies.get(user.id.replace(/-user$/, '-secretary'));
      return reply ? [{ user: user.text, reply }] : [];
    });
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  let characters = 0;
  let truncated = false;
  for (let index = pairs.length - 1; index >= 0; index--) {
    const pair = pairs[index];
    const userText = pair.user.slice(0, 4000);
    const replyText = pair.reply.slice(0, 4000);
    if (messages.length + 2 > 20 || characters + userText.length + replyText.length > 16000) {
      truncated = true;
      break;
    }
    if (userText.length < pair.user.length || replyText.length < pair.reply.length)
      truncated = true;
    messages.unshift({ role: 'user', text: userText }, { role: 'assistant', text: replyText });
    characters += userText.length + replyText.length;
  }
  return { messages, truncated };
}

/** Validate explicit selection using the existing server-owned allowed lists. */
export function narrowFrontDeskConversationViewer(
  viewer: FrontDeskConversationViewer,
  selection: { tenant?: string | null; organizationId?: string | null; projectId?: string | null }
): FrontDeskConversationViewer {
  return { ...viewer, ...narrowSurfaceViewerScope(viewer, selection) };
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

/** Only a typed pre-execution admission rejection may call this. Unknown
 * execution outcomes never become retryable just because a client asks again. */
export function markConversationTurnNotStarted(
  viewer: FrontDeskConversationViewer,
  id: string
): void {
  const ref = conversationRef(viewer);
  asStore(viewer, () =>
    withLockSync(`concierge-history-${ref.key}`, () => {
      const transcript = load(ref);
      const turn = transcript.turns.find((entry) => entry.id === id);
      if (!turn || turn.reply !== undefined || turn.uncertain)
        throw new ConversationStoreError('invalid_history');
      turn.retryable = true;
      publishTranscript(ref, transcript);
    })
  );
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
      !['pending', 'invalidated', 'cancel_requested'].includes(String(row.status)) ||
      typeof row.createdAt !== 'number' ||
      !Number.isFinite(row.createdAt) ||
      row.createdAt < 0 ||
      !state.tasks.some(
        (task) => task.id === binding.request_id && task.workItemId === binding.work_item_id
      ) ||
      ids.has(binding.request_id)
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
function executionAdmission(
  viewer: FrontDeskConversationViewer,
  text: string,
  requestId: string,
  ref: ReturnType<typeof conversationRef>,
  state: ConversationTaskState,
  locale?: SupportedLocale
):
  | {
      routed: { state: ConversationTaskState; decision: ConversationTaskDecision };
      request: FrontDeskExecutionRequest;
    }
  | undefined {
  if (!isFrontDeskExecutionPublicViewer(viewer)) return undefined;
  const mapping = loadFrontDeskExecutionPolicy().mappings.find(
    (entry) => text === entry.exactCommand && frontDeskExecutionViewerMatches(viewer, entry)
  );
  if (!mapping || !isFrontDeskExecutionPublicViewer(mapping.viewer)) return undefined;
  let digest: string;
  try {
    if (!frontDeskRuntimeScope(viewer).tenant_slug) return undefined;
    digest = frontDeskMappingDigest(mapping);
  } catch {
    return undefined;
  }
  let task = state.tasks.find((entry) => entry.id === requestId);
  if (!task) {
    if (state.tasks.length >= CONVERSATION_TASK_MAX_TASKS) return undefined;
    task = {
      id: requestId,
      title: storedText(text, 512),
      requestText: storedText(text, CONVERSATION_MAX_INPUT),
      createdAt: Date.now(),
      updates: [],
      state: 'needs_execution',
    };
    state.tasks.push(task);
  }
  const requestDigest = createHash('sha256').update(text).digest('hex');
  const binding: FrontDeskExecutionBinding = {
    mapping_id: mapping.id,
    config_digest: digest,
    conversation_key: ref.key,
    request_id: requestId,
    revision: 1,
    request_digest: requestDigest,
    work_item_id:
      'WI-FD-' +
      createHash('sha256')
        .update(JSON.stringify([mapping.id, digest, ref.key, requestId, 1, requestDigest]))
        .digest('hex')
        .slice(0, 48),
  };
  task.workItemId = binding.work_item_id;
  task.state = 'needs_execution';
  delete task.result;
  delete state.clarification;
  return {
    routed: {
      state,
      decision: {
        kind: 'new_request',
        taskIds: [requestId],
        confidence: 'rule',
        authority: 'none',
        reply: t('front_desk:execution_acknowledged', undefined, locale),
      },
    },
    request: {
      binding,
      viewer: structuredClone(viewer),
      sessionId: ref.sessionId,
      revision: 1,
      requestDigest,
      status: 'pending',
      createdAt: Date.now(),
    },
  };
}
function executionProjection(
  viewer: FrontDeskConversationViewer,
  request: FrontDeskExecutionRequest,
  locale?: SupportedLocale
): FrontDeskExecutionProjection | undefined {
  if (request.status === 'cancel_requested')
    return {
      status: 'cancel_requested',
      text: t('front_desk:execution_cancel_requested', undefined, locale),
    };
  if (request.status === 'invalidated')
    return { status: 'blocked', text: t('front_desk:execution_invalidated', undefined, locale) };
  try {
    return projectFrontDeskExecution(viewer, request.binding, { locale });
  } catch {
    return undefined;
  } // A report read failure never retries or re-dispatches work.
}
function syncExecutionReports(
  viewer: FrontDeskConversationViewer,
  transcript: Transcript
): boolean {
  const reports = transcript.executionReports ?? [];
  let changed = false;
  for (const request of transcript.executionRequests ?? []) {
    const projection = executionProjection(viewer, request);
    if (
      !projection?.reportId ||
      !validText(projection.reportId, 256) ||
      !validText(projection.text, CONVERSATION_MAX_REPLY)
    )
      continue;
    const index = reports.findIndex((report) => report.requestId === request.binding.request_id);
    const previous = index < 0 ? undefined : reports[index];
    if (previous?.id === projection.reportId && previous.status === projection.status) continue;
    if (
      reports.some(
        (report) =>
          report.id === projection.reportId && report.requestId !== request.binding.request_id
      )
    )
      continue;
    const report: FrontDeskExecutionReport = {
      id: projection.reportId,
      requestId: request.binding.request_id,
      status: projection.status,
      text: storedText(projection.text, CONVERSATION_MAX_REPLY),
      createdAt: Date.now(),
    };
    // A correction replaces this request's slot, so every admitted request can
    // always acquire its own receipt without an unbounded history of corrections.
    if (index >= 0) reports[index] = report;
    else if (reports.length < CONVERSATION_TASK_MAX_TASKS) reports.push(report);
    else continue;
    changed = true;
  }
  if (changed) transcript.executionReports = reports;
  return changed;
}

/** Front-desk-owned projection only. Executors never write transcripts. */
export function readConversationExecutionReports(
  viewer: FrontDeskConversationViewer
): FrontDeskExecutionReport[] {
  const ref = conversationRef(viewer);
  return asStore(viewer, () =>
    withLockSync(`concierge-history-${ref.key}`, () => {
      const transcript = load(ref);
      if (syncExecutionReports(viewer, transcript)) publishTranscript(ref, transcript);
      return structuredClone(transcript.executionReports ?? []);
    })
  );
}
/** Enumerate only explicitly configured partitions. No global transcript scan or bodies. */
export function listConfiguredFrontDeskExecutions(): Array<{
  mapping: FrontDeskExecutionMapping;
  binding: FrontDeskExecutionBinding;
  request: Omit<FrontDeskExecutionRequest, 'binding' | 'viewer'>;
}> {
  const found: Array<{
    mapping: FrontDeskExecutionMapping;
    binding: FrontDeskExecutionBinding;
    request: Omit<FrontDeskExecutionRequest, 'binding' | 'viewer'>;
  }> = [];
  for (const mapping of loadFrontDeskExecutionPolicy().mappings) {
    if (!isFrontDeskExecutionPublicViewer(mapping.viewer)) continue;
    try {
      const ref = conversationRef(mapping.viewer);
      asStore(mapping.viewer, () => {
        for (const request of load(ref).executionRequests ?? []) {
          if (request.binding.mapping_id !== mapping.id) continue;
          const { binding, viewer: _viewer, ...summary } = request;
          found.push({ mapping, binding, request: summary });
        }
      });
    } catch {
      /* A malformed or inaccessible partition never gains execution authority. */
    }
  }
  return found;
}
/** Fresh pre-effect authorization check; does not write or consume request state. */
export function inspectFrontDeskExecution(
  binding: FrontDeskExecutionBinding,
  charter: {
    dot_id: string;
    status: string;
    scope: {
      tier: 'public' | 'confidential' | 'personal';
      tenant_slug?: string;
      organization_id?: string;
      project_id?: string;
    };
  }
):
  | {
      ok: true;
      mapping: FrontDeskExecutionMapping;
      requestText: string;
      artifactPath: string;
      expectedContent: string;
    }
  | { ok: false; reason: string } {
  const blocked = (reason: string) => ({ ok: false as const, reason });
  const mapping = getFrontDeskExecutionMapping(binding);
  if (!mapping) return blocked('configuration_changed');
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
        task.requestText !== mapping.exactCommand ||
        task.updates.length !== 0 ||
        createHash('sha256').update(task.requestText).digest('hex') !== binding.request_digest
      )
        return blocked('request_changed');
      return {
        ok: true as const,
        mapping,
        requestText: task.requestText,
        artifactPath: frontDeskExecutionArtifactPath(binding, mapping),
        expectedContent: frontDeskExecutionExpectedContent(binding, mapping, request.sessionId),
      };
    });
  } catch {
    return blocked('request_unavailable');
  }
}
