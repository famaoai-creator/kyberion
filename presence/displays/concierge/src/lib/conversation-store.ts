import { createHash, randomUUID } from 'node:crypto';
import { withExecutionContext } from '@agent/core/authority';
import { withLockSync } from '@agent/core/lock-utils';
import { physicalScopedPath } from '@agent/core/physical-namespace';
import { redactSensitiveString } from '@agent/core/network';
import {
  readGovernedArtifactJson,
  writeGovernedArtifactJson,
} from '@agent/core/workforce/artifact-store';
import { conciergeConversationScope, type ConciergeViewerContext } from './viewer-context';
import {
  CONVERSATION_MAX_INPUT,
  CONVERSATION_MAX_REPLY,
  CONVERSATION_MAX_TURNS,
  type ConversationHistory,
} from './conversation-history';

type Turn = { id: string; text: string; createdAt: number; reply?: string };
const PENDING_RETENTION_MS = 24 * 60 * 60 * 1000;
type Transcript = { version: 1; sessionId: string; turns: Turn[] };

export class ConversationStoreError extends Error {
  constructor(public readonly code: 'identity_required' | 'invalid_history' | 'invalid_text') {
    super(code);
  }
}

function canonicalScope(value: string[] | 'all'): string[] | 'all' {
  return value === 'all' ? value : [...new Set(value)].sort();
}

/** The principal and every authorization restriction come from the server. */
export function conversationRef(viewer: ConciergeViewerContext) {
  if (viewer.source === 'anonymous' || !viewer.principalId?.trim()) {
    throw new ConversationStoreError('identity_required');
  }
  const scope = conciergeConversationScope(viewer);
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

function asStore<T>(viewer: ConciergeViewerContext, fn: () => T): T {
  const scope = conciergeConversationScope(viewer);
  return withExecutionContext('sovereign_concierge', fn, undefined, scope.tenant_slug);
}

function validText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}

function load(ref: ReturnType<typeof conversationRef>): Transcript {
  const value = readGovernedArtifactJson<unknown>(ref.path);
  if (value === null) return { version: 1, sessionId: ref.sessionId, turns: [] };
  if (!value || typeof value !== 'object') throw new ConversationStoreError('invalid_history');
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
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
      (turn.reply !== undefined && !validText(turn.reply, CONVERSATION_MAX_REPLY))
    ) {
      throw new ConversationStoreError('invalid_history');
    }
    ids.add(turn.id);
    return {
      id: turn.id,
      text: turn.text,
      createdAt: turn.createdAt,
      ...(turn.reply === undefined ? {} : { reply: turn.reply }),
    };
  });
  return { version: 1, sessionId: ref.sessionId, turns };
}

/** Known/registered credentials are redacted; arbitrary passwords cannot be inferred. */
function storedText(text: string): string {
  return redactSensitiveString(text)
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      '[REDACTED_SECRET]'
    )
    .replace(
      /\b(password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
      '$1=[REDACTED_SECRET]'
    );
}

export function readConversationHistory(viewer: ConciergeViewerContext): ConversationHistory {
  const ref = conversationRef(viewer);
  return asStore(viewer, () => {
    const transcript = load(ref);
    return {
      sessionId: ref.sessionId,
      pending: transcript.turns.filter((turn) => turn.reply === undefined).length,
      messages: transcript.turns.flatMap((turn) => [
        { id: `${turn.id}-user`, role: 'user' as const, text: storedText(turn.text) },
        ...(turn.reply === undefined
          ? []
          : [
              {
                id: `${turn.id}-secretary`,
                role: 'secretary' as const,
                text: storedText(turn.reply),
              },
            ]),
      ]),
    };
  });
}

export function beginConversationTurn(viewer: ConciergeViewerContext, text: string): string {
  if (!validText(text, CONVERSATION_MAX_INPUT)) throw new ConversationStoreError('invalid_text');
  const ref = conversationRef(viewer);
  return asStore(viewer, () =>
    withLockSync(`concierge-history-${ref.key}`, () => {
      const transcript = load(ref);
      const id = randomUUID();
      // Do not evict a pending turn that another process is still completing.
      if (transcript.turns.length === CONVERSATION_MAX_TURNS) {
        const completed = transcript.turns.findIndex(
          (turn) => turn.reply !== undefined || Date.now() - turn.createdAt >= PENDING_RETENTION_MS
        );
        if (completed < 0) throw new ConversationStoreError('invalid_history');
        transcript.turns.splice(completed, 1);
      }
      transcript.turns.push({ id, text: storedText(text), createdAt: Date.now() });
      writeGovernedArtifactJson('sovereign_concierge', ref.path, transcript);
      return id;
    })
  );
}

export function completeConversationTurn(
  viewer: ConciergeViewerContext,
  id: string,
  reply: string
): void {
  if (!validText(reply, CONVERSATION_MAX_REPLY)) throw new ConversationStoreError('invalid_text');
  const ref = conversationRef(viewer);
  asStore(viewer, () =>
    withLockSync(`concierge-history-${ref.key}`, () => {
      const transcript = load(ref);
      const turn = transcript.turns.find((entry) => entry.id === id);
      if (!turn || turn.reply !== undefined) throw new ConversationStoreError('invalid_history');
      turn.reply = storedText(reply);
      writeGovernedArtifactJson('sovereign_concierge', ref.path, transcript);
    })
  );
}
