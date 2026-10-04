import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrontDeskConversationViewer as ConciergeViewerContext } from './front-desk-conversation-store.js';

const files = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../authority.js', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('../lock-utils.js', () => ({
  withLockSync: (_key: string, fn: () => unknown) => fn(),
}));
vi.mock('../workforce/artifact-store.js', () => ({
  readGovernedArtifactJson: (path: string) => structuredClone(files.get(path) ?? null),
  writeGovernedArtifactJson: (_role: string, path: string, value: unknown) =>
    files.set(path, structuredClone(value)),
}));

import {
  beginConversationTurn,
  completeConversationTurn,
  conversationRef,
  readConversationHistory,
  reserveConversationTurn,
  completedConversationContext,
  narrowFrontDeskConversationViewer,
  frontDeskRuntimeScope,
  markConversationTurnNotStarted,
  markConversationTurnUncertain,
  presenceFrontDeskConversationViewer,
} from './front-desk-conversation-store.js';

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
    const id = beginConversationTurn(viewer, 'Prepare the report tomorrow');
    expect(readConversationHistory(viewer)).toMatchObject({
      pending: 1,
      messages: [{ role: 'user', text: 'Prepare the report tomorrow' }],
    });
    completeConversationTurn(viewer, id, 'The report is ready for review');
    expect(readConversationHistory(viewer)).toMatchObject({
      pending: 0,
      messages: [
        { role: 'user', text: 'Prepare the report tomorrow' },
        { role: 'secretary', text: 'The report is ready for review' },
      ],
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
    const first = beginConversationTurn(viewer, 'first');
    const second = beginConversationTurn(viewer, 'second');
    completeConversationTurn(viewer, second, 'second reply');
    completeConversationTurn(viewer, first, 'first reply');
    expect(readConversationHistory(viewer).messages.map((message) => message.text)).toEqual([
      'first',
      'first reply',
      'second',
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

describe('shared surface compatibility and duplicate protection', () => {
  it('preserves the exact existing Concierge key for the loopback operator', () => {
    const concierge = {
      ...viewer,
      source: 'loopback' as const,
      principalId: 'human:concierge-localadmin',
      tenantSlugs: 'all' as const,
      organizationIds: 'all' as const,
      projectIds: 'all' as const,
    };
    const presence = {
      ...concierge,
      principalId: 'human:presence-studio-localadmin',
      tierAccess: ['personal', 'confidential', 'public'] as ConciergeViewerContext['tierAccess'],
    };
    expect(conversationRef(presenceFrontDeskConversationViewer(presence))).toEqual(
      conversationRef(concierge)
    );
    beginConversationTurn(concierge, 'already stored');
    expect(
      readConversationHistory(presenceFrontDeskConversationViewer(presence)).messages[0].text
    ).toBe('already stored');
  });
  it('never aliases token identities or custom principals', () => {
    const token = { ...viewer, principalId: 'human:presence-studio-localadmin' };
    expect(presenceFrontDeskConversationViewer(token)).toBe(token);
    const actual = { ...viewer, source: 'loopback' as const, principalId: 'human:actual-user' };
    expect(presenceFrontDeskConversationViewer(actual)).toBe(actual);
  });
  it('reserves once and returns the same completed turn without rerunning it', () => {
    const key = '12345678-1234-4234-8234-123456789abc';
    expect(reserveConversationTurn(viewer, 'request', key)).toMatchObject({
      id: key,
      created: true,
    });
    expect(reserveConversationTurn(viewer, 'request', key)).toMatchObject({
      id: key,
      created: false,
    });
    completeConversationTurn(viewer, key, 'result');
    expect(reserveConversationTurn(viewer, 'request', key)).toMatchObject({
      created: false,
      reply: 'result',
    });
    expect(readConversationHistory(viewer).messages).toHaveLength(2);
    expect(() => reserveConversationTurn(viewer, 'different', key)).toThrow('request_conflict');
  });
  it('keeps uncertain execution pending, never a success reply or a blind retry', () => {
    const turn = reserveConversationTurn(viewer, 'request');
    markConversationTurnUncertain(viewer, turn.id);
    expect(reserveConversationTurn(viewer, 'request', turn.id)).toMatchObject({
      created: false,
      uncertain: true,
    });
    expect(readConversationHistory(viewer)).toMatchObject({
      pending: 1,
      messages: [{ role: 'user', text: 'request' }],
    });
  });
});

describe('bounded retry receipts', () => {
  it('does not execute a request again after its completed turn leaves visible history', () => {
    const first = reserveConversationTurn(viewer, 'first request');
    completeConversationTurn(viewer, first.id, 'first result');
    for (let i = 0; i < 50; i++) {
      const next = reserveConversationTurn(viewer, 'later ' + i);
      completeConversationTurn(viewer, next.id, 'result');
    }
    expect(readConversationHistory(viewer).messages[0].text).not.toBe('first request');
    expect(() => reserveConversationTurn(viewer, 'first request', first.id)).toThrow(
      'request_conflict'
    );
  });
  it('rejects a retry carrying an expired or future request timestamp', () => {
    expect(() =>
      reserveConversationTurn(
        viewer,
        'work',
        '12345678-1234-4234-8234-123456789abc',
        Date.now() - 24 * 60 * 60 * 1000
      )
    ).toThrow('request_expired');
    expect(() =>
      reserveConversationTurn(
        viewer,
        'work',
        '12345678-1234-4234-8234-123456789abc',
        Date.now() + 120000
      )
    ).toThrow('request_expired');
    expect(files.size).toBe(0);
  });
});

describe('independent continuity review regressions', () => {
  it('loads a literal baseline v1 transcript at its unchanged key and path', () => {
    // Captured from main fc216c5 hash-field ordering and physicalScopedPath.
    const key = '8986bf9f45ecbf4e7d84b8e3215cbdb7631cd21d956d46d09b22247e0a5a3199';
    const path =
      'active/shared/coordination/channels/concierge/conversations/tenants/tenant-a/' +
      key +
      '.json';
    const id = '12345678-1234-4234-8234-123456789abc';
    files.set(path, {
      version: 1,
      sessionId: 'concierge-' + key,
      turns: [
        { id, text: 'Existing legacy request', createdAt: 1000, reply: 'Existing legacy reply' },
      ],
    });
    expect(conversationRef(viewer)).toMatchObject({ key, path, sessionId: 'concierge-' + key });
    expect(readConversationHistory(viewer).messages.map((message) => message.id)).toEqual([
      id + '-user',
      id + '-secretary',
    ]);
    expect(reserveConversationTurn(viewer, 'Existing legacy request', id)).toMatchObject({
      created: false,
      reply: 'Existing legacy reply',
    });
  });
  it('binds raw input before redaction and truncation', () => {
    const turn = reserveConversationTurn(viewer, 'password=one');
    expect(() => reserveConversationTurn(viewer, 'password=two', turn.id)).toThrow(
      'request_conflict'
    );
    const prefix = 'password=a '.repeat(744);
    const expanded = reserveConversationTurn(viewer, prefix + 'one');
    expect(() => reserveConversationTurn(viewer, prefix + 'two', expanded.id)).toThrow(
      'request_conflict'
    );
    expect(JSON.stringify([...files.values()])).not.toContain('password=one');
  });
  it('retains receipts for 24 hours from server reservation despite backdated client time', () => {
    const now = 1791115000000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const first = reserveConversationTurn(
        viewer,
        'first',
        undefined,
        now - 24 * 60 * 60 * 1000 + 60000
      );
      completeConversationTurn(viewer, first.id, 'done');
      for (let i = 0; i < 50; i++) {
        const next = reserveConversationTurn(viewer, 'later ' + i);
        completeConversationTurn(viewer, next.id, 'done');
      }
      clock.mockReturnValue(now + 120000);
      expect(() => reserveConversationTurn(viewer, 'first', first.id)).toThrow('request_conflict');
    } finally {
      clock.mockRestore();
    }
  });
});

describe('bounded scoped execution context', () => {
  it('restores only completed pairs after a fresh reader, with no action metadata', () => {
    const first = beginConversationTurn(viewer, 'Remember this requirement');
    completeConversationTurn(viewer, first, 'Recorded requirement');
    beginConversationTurn(viewer, 'Uncertain request must not replay');
    expect(completedConversationContext(viewer)).toEqual({
      messages: [
        { role: 'user', text: 'Remember this requirement' },
        { role: 'assistant', text: 'Recorded requirement' },
      ],
      truncated: false,
    });
    expect(completedConversationContext({ ...viewer, principalId: 'human:bob' }).messages).toEqual(
      []
    );
  });
  it('bounds and accurately reports discarded history', () => {
    for (let i = 0; i < 12; i++) {
      const id = beginConversationTurn(viewer, 'u'.repeat(5000));
      completeConversationTurn(viewer, id, 'a'.repeat(5000));
    }
    const result = completedConversationContext(viewer);
    expect(result.truncated).toBe(true);
    expect(result.messages.length).toBeLessThanOrEqual(20);
    expect(result.messages.reduce((sum, m) => sum + m.text.length, 0)).toBeLessThanOrEqual(16000);
    expect(result.messages.every((m) => m.text.length <= 4000)).toBe(true);
  });
  it('supports unrestricted local scope and single authorized lineage without changing storage key', () => {
    expect(
      frontDeskRuntimeScope({
        ...viewer,
        tenantSlugs: 'all',
        organizationIds: 'all',
        projectIds: 'all',
      })
    ).toMatchObject({ scope_kind: 'system', tier: 'public', viewer_principal: 'human:alice' });
    expect(frontDeskRuntimeScope(viewer)).toEqual({
      scope_kind: 'project',
      tier: 'confidential',
      tenant_slug: 'tenant-a',
      organization_id: 'org-a',
      project_id: 'project-a',
      viewer_principal: 'human:alice',
    });
  });
  it('requires explicit selection for ambiguous/empty restrictions and refuses out-of-list targets', () => {
    const multiple = {
      ...viewer,
      organizationIds: ['org-a', 'org-b'],
      projectIds: ['project-a', 'project-b'],
    };
    expect(() => frontDeskRuntimeScope(multiple)).toThrow('scope_selection_required');
    expect(() => frontDeskRuntimeScope({ ...viewer, projectIds: [] })).toThrow(
      'scope_selection_required'
    );
    expect(() => narrowFrontDeskConversationViewer(multiple, { projectId: 'project-c' })).toThrow();
    const narrowed = narrowFrontDeskConversationViewer(multiple, {
      organizationId: 'org-a',
      projectId: 'project-a',
    });
    expect(frontDeskRuntimeScope(narrowed)).toMatchObject({
      organization_id: 'org-a',
      project_id: 'project-a',
    });
  });
  it('allows an explicit same-ID retry only after a proven not-started reservation', () => {
    const first = reserveConversationTurn(viewer, 'work');
    markConversationTurnNotStarted(viewer, first.id);
    expect(reserveConversationTurn(viewer, 'work', first.id)).toMatchObject({
      created: true,
      id: first.id,
    });
    expect(reserveConversationTurn(viewer, 'work', first.id)).toMatchObject({
      created: false,
      id: first.id,
    });
    markConversationTurnUncertain(viewer, first.id);
    expect(() => markConversationTurnNotStarted(viewer, first.id)).toThrow('invalid_history');
    expect(readConversationHistory(viewer).messages).toHaveLength(1);
  });
});
