import { createHash, randomUUID } from 'node:crypto';
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
import {
  routeConversationTaskTurn,
  parseConversationTaskState,
  parseConversationTaskDecision,
  type ConversationTaskState,
  type ConversationTaskDecision,
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
  version: 2;
  sessionId: string;
  turns: Turn[];
  taskState?: ConversationTaskState;
  droppedRequests?: Array<{ id: string; createdAt: number }>;
};
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
    (record.version !== 1 && record.version !== 2) ||
    (record.version === 2 && record.taskState === undefined) ||
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
    version: 2,
    sessionId: ref.sessionId,
    turns,
    taskState,
    droppedRequests: dropped.map((entry) => ({ id: entry.id, createdAt: entry.createdAt })),
  };
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
  return asStore(viewer, () => {
    const transcript = load(ref);
    return {
      sessionId: ref.sessionId,
      pending: transcript.turns.filter((turn) => turn.reply === undefined && !turn.retryable)
        .length,
      messages: transcript.turns.flatMap((turn) => [
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
                text: storedText(turn.reply, CONVERSATION_MAX_REPLY),
              },
            ]),
      ]),
    };
  });
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
  if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new ConversationStoreError('invalid_text');
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
          writeGovernedArtifactJson('sovereign_concierge', ref.path, transcript);
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
      const routed = routeConversationTaskTurn(
        transcript.taskState ?? { tasks: [] },
        storedText(text, CONVERSATION_MAX_INPUT),
        id,
        Date.now(),
        locale
      );
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
      writeGovernedArtifactJson('sovereign_concierge', ref.path, transcript);
      return { id, created: true, routing: routed.decision };
    })
  );
}

export function completeConversationTurn(
  viewer: FrontDeskConversationViewer,
  id: string,
  reply: string
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
      writeGovernedArtifactJson('sovereign_concierge', ref.path, transcript);
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
      writeGovernedArtifactJson('sovereign_concierge', ref.path, transcript);
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
      writeGovernedArtifactJson('sovereign_concierge', ref.path, transcript);
    })
  );
}
