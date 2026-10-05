import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConciergeViewerContext } from './viewer-context';

const files = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/lock-utils', () => ({
  withLockSync: (_key: string, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/workforce/artifact-store', () => ({
  readGovernedArtifactJson: (path: string) => structuredClone(files.get(path) ?? null),
  writeGovernedArtifactJson: (_role: string, path: string, value: unknown) =>
    files.set(path, structuredClone(value)),
}));
vi.mock('./viewer-context', () => ({
  conciergeConversationScope: (viewer: ConciergeViewerContext) =>
    viewer.tenantSlugs !== 'all' && viewer.tenantSlugs.length === 1
      ? {
          scope_kind: 'tenant',
          tier: viewer.tierAccess.includes('confidential') ? 'confidential' : 'public',
          tenant_slug: viewer.tenantSlugs[0],
        }
      : { scope_kind: 'system', tier: 'public' },
}));

import {
  beginConversationTurn,
  completeConversationTurn,
  conversationRef,
  readConversationHistory,
  reserveConversationTurn,
} from './conversation-store';

const viewer: ConciergeViewerContext = {
  principalId: 'human:alice',
  role: 'localadmin',
  source: 'token',
  tenantSlugs: ['tenant-a'],
  organizationIds: ['org-a'],
  projectIds: ['project-a'],
  tierAccess: ['public', 'confidential'],
};

beforeEach(() => files.clear());

describe('server-owned durable conversation', () => {
  it('restores a pending request without executing it; completes the same turn later', () => {
    const id = beginConversationTurn(viewer, 'Hello from Alice');
    expect(readConversationHistory(viewer)).toMatchObject({
      pending: 1,
      messages: [{ role: 'user', text: 'Hello from Alice' }],
    });
    completeConversationTurn(viewer, id, 'The report is ready for review');
    expect(readConversationHistory(viewer)).toMatchObject({
      pending: 0,
      messages: [
        { role: 'user', text: 'Hello from Alice' },
        { role: 'secretary', text: 'The report is ready for review' },
      ],
    });
  });

  it('records a recognized request and completes it when the runtime answers in place', () => {
    const text = 'Prepare the report tomorrow';
    const id = '00000000-0000-4000-8000-000000000001';
    const turn = reserveConversationTurn(viewer, text, id, Date.now(), 'en');
    expect(turn).toMatchObject({
      created: true,
      routing: { kind: 'new_request', authority: 'none', taskIds: [id] },
    });
    expect(turn.routing?.reply).toBeUndefined();
    expect(readConversationHistory(viewer)).toMatchObject({
      pending: 1,
      messages: [{ role: 'user', text }],
    });
    expect(files.get(conversationRef(viewer).path)).toMatchObject({
      taskState: {
        tasks: [{ id, state: 'recorded', requestText: text }],
      },
    });
    completeConversationTurn(viewer, id, 'The report is ready', 'answered');
    expect(readConversationHistory(viewer)).toMatchObject({
      pending: 0,
      messages: [
        { role: 'user', text },
        { role: 'secretary', text: 'The report is ready' },
      ],
    });
    expect(reserveConversationTurn(viewer, text, id, Date.now(), 'en')).toMatchObject({
      created: false,
      id,
      reply: 'The report is ready',
      routing: turn.routing,
    });
    expect(files.get(conversationRef(viewer).path)).toMatchObject({
      taskState: {
        tasks: [{ id, state: 'completed', result: { turnId: id, excerpt: 'The report is ready' } }],
      },
    });
  });

  it.each([
    { principalId: 'human:bob' },
    { memberId: 'member-b' },
    { tenantSlugs: ['tenant-b'] },
    { organizationIds: ['org-b'] },
    { projectIds: ['project-b'] },
    { tierAccess: ['public'] },
    { role: 'readonly' },
    { source: 'loopback' },
  ])('isolates changed identity or permission: %j', (change) => {
    beginConversationTurn(viewer, 'Confidential request');
    const other = { ...viewer, ...change } as ConciergeViewerContext;
    expect(conversationRef(other).sessionId).not.toBe(conversationRef(viewer).sessionId);
    expect(readConversationHistory(other).messages).toEqual([]);
  });

  it('canonicalizes unordered permission sets, and uses the tenant namespace', () => {
    expect(
      conversationRef({ ...viewer, tierAccess: ['confidential', 'public', 'public'] }).sessionId
    ).toBe(conversationRef(viewer).sessionId);
    expect(conversationRef(viewer).path).toContain('/tenants/tenant-a/');
    expect(conversationRef({ ...viewer, tenantSlugs: 'all' }).sessionId).not.toBe(
      conversationRef({ ...viewer, tenantSlugs: [] }).sessionId
    );
  });

  it('rejects missing and anonymous principals before storage', () => {
    expect(() => beginConversationTurn({ ...viewer, principalId: undefined }, 'test')).toThrow(
      'identity_required'
    );
    expect(() => readConversationHistory({ ...viewer, source: 'anonymous' })).toThrow(
      'identity_required'
    );
    expect(files.size).toBe(0);
  });

  it('matches replies to their turn even when requests finish in reverse order', () => {
    const first = beginConversationTurn(viewer, 'earlier greeting');
    const second = beginConversationTurn(viewer, 'later greeting');
    completeConversationTurn(viewer, second, 'second reply');
    completeConversationTurn(viewer, first, 'first reply');
    expect(readConversationHistory(viewer).messages.map((message) => message.text)).toEqual([
      'earlier greeting',
      'first reply',
      'later greeting',
      'second reply',
    ]);
  });

  it('bounds input and retention, retaining pending turns', () => {
    expect(() => beginConversationTurn(viewer, 'x'.repeat(8193))).toThrow('invalid_text');
    const pending = beginConversationTurn(viewer, 'pending');
    for (let index = 0; index < 52; index++) {
      const id = beginConversationTurn(viewer, `request ${index}`);
      completeConversationTurn(viewer, id, `reply ${index}`);
    }
    const history = readConversationHistory(viewer);
    expect(history.messages.length).toBe(99);
    expect(history.pending).toBe(1);
    completeConversationTurn(viewer, pending, 'late reply');
    expect(readConversationHistory(viewer).messages.length).toBe(100);
  });

  it('redacts recognized credentials and explicit credential assignments', () => {
    const id = beginConversationTurn(
      viewer,
      `api_key=sk-${'a'.repeat(24)} password="do-not-store-this"`
    );
    completeConversationTurn(viewer, id, 'client_secret=do-not-store-this');
    const serialized = JSON.stringify([...files.values()]);
    expect(serialized).not.toContain('do-not-store-this');
    expect(serialized).not.toContain(`sk-${'a'.repeat(24)}`);
    expect(serialized).toContain('[REDACTED_SECRET]');
  });

  it('keeps history readable when redacting short credentials expands input and replies', () => {
    const id = beginConversationTurn(viewer, 'password=a '.repeat(744));
    completeConversationTurn(viewer, id, 'password=b '.repeat(2978));
    const history = readConversationHistory(viewer);
    expect(history.pending).toBe(0);
    expect(history.messages[0].text.length).toBeLessThanOrEqual(8192);
    expect(history.messages[1].text.length).toBeLessThanOrEqual(32768);
    expect(JSON.stringify([...files.values()])).not.toMatch(/password=[ab]/);
    const next = beginConversationTurn(viewer, 'next request');
    completeConversationTurn(viewer, next, 'next reply');
    expect(readConversationHistory(viewer).messages.at(-1)?.text).toBe('next reply');
  });

  it('recovers capacity after abandoned requests expire without replaying them', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      for (let index = 0; index < 50; index++) beginConversationTurn(viewer, `pending ${index}`);
      expect(() => beginConversationTurn(viewer, 'new request')).toThrow('invalid_history');
      clock.mockReturnValue(1000 + 24 * 60 * 60 * 1000);
      beginConversationTurn(viewer, 'new request');
      const history = readConversationHistory(viewer);
      expect(history.pending).toBe(50);
      expect(history.messages[0].text).toBe('pending 1');
      expect(history.messages.at(-1)?.text).toBe('new request');
    } finally {
      clock.mockRestore();
    }
  });

  it('fails closed on corrupt or swapped stored records rather than overwriting them', () => {
    const ref = conversationRef(viewer);
    files.set(ref.path, { version: 1, sessionId: 'another-user', turns: [] });
    expect(() => readConversationHistory(viewer)).toThrow('invalid_history');
    expect(() => beginConversationTurn(viewer, 'request')).toThrow('invalid_history');
    expect(files.get(ref.path)).toMatchObject({ sessionId: 'another-user' });
  });
});
