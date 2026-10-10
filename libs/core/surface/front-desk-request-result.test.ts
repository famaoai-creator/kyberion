import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrontDeskConversationViewer } from './front-desk-conversation-store.js';

const state = vi.hoisted(() => ({ files: new Map<string, unknown>(), writes: 0, locks: 0 }));
vi.mock('../authority.js', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('../lock-utils.js', () => ({
  withLockSync: (_key: string, fn: () => unknown) => {
    state.locks++;
    return fn();
  },
}));
vi.mock('../workforce/artifact-store.js', () => ({
  readGovernedArtifactJson: (path: string) => structuredClone(state.files.get(path) ?? null),
  writeGovernedArtifactJson: (_role: string, path: string, value: unknown) => {
    state.writes++;
    state.files.set(path, structuredClone(value));
  },
}));
import {
  reserveConversationTurn,
  completeConversationTurn,
  markConversationTurnNotStarted,
  markConversationTurnUncertain,
  conversationRef,
} from './front-desk-conversation-store.js';
import { readFrontDeskRequest, readFrontDeskRequestArtifact } from './front-desk-request-result.js';

const ID = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const viewer: FrontDeskConversationViewer = {
  principalId: 'human:alice',
  memberId: 'alice',
  role: 'localadmin',
  source: 'token',
  tenantSlugs: ['tenant-a'],
  organizationIds: ['org-a'],
  projectIds: ['project-a'],
  tierAccess: ['public', 'confidential'],
};

beforeEach(() => {
  state.files.clear();
  state.writes = 0;
  state.locks = 0;
});

describe('exact durable request readback', () => {
  it('returns the same ID and inert reply to an independently reconstructed authorized viewer', () => {
    reserveConversationTurn(viewer, 'Hello', ID);
    completeConversationTurn(viewer, ID, 'Hello, Alice.');
    const before = { writes: state.writes, locks: state.locks };
    const snapshot = readFrontDeskRequest(structuredClone(viewer), ID);
    expect(snapshot).toEqual({
      requestId: ID,
      sessionId: conversationRef(viewer).sessionId,
      replyStatus: 'answered',
      reply: 'Hello, Alice.',
      work: [],
    });
    expect(snapshot).not.toHaveProperty('executionStatus');
    expect(snapshot).not.toHaveProperty('nextActions');
    expect({ writes: state.writes, locks: state.locks }).toEqual(before);
  });

  it.each([
    { principalId: 'human:bob' },
    { memberId: 'bob' },
    { tenantSlugs: ['tenant-b'] },
    { organizationIds: ['org-b'] },
    { projectIds: ['project-b'] },
    { tierAccess: ['public'] },
    { role: 'readonly' },
    { source: 'loopback' },
  ])('does not use request ID as authorization when claims differ: %j', (change) => {
    reserveConversationTurn(viewer, 'Hello', ID);
    completeConversationTurn(viewer, ID, 'Private reply');
    expect(
      readFrontDeskRequest({ ...viewer, ...change } as FrontDeskConversationViewer, ID)
    ).toBeUndefined();
  });

  it('keeps unanswered, not-started and uncertain states distinct after fresh reads', () => {
    reserveConversationTurn(viewer, 'Hello', ID);
    expect(readFrontDeskRequest(viewer, ID)?.replyStatus).toBe('pending');
    markConversationTurnNotStarted(viewer, ID);
    expect(readFrontDeskRequest(viewer, ID)?.replyStatus).toBe('not_started');
    reserveConversationTurn(viewer, 'Hello', ID);
    markConversationTurnUncertain(viewer, ID);
    expect(readFrontDeskRequest(viewer, ID)).toMatchObject({ replyStatus: 'uncertain' });
    expect(readFrontDeskRequest(viewer, ID)).not.toHaveProperty('reply');
    expect(reserveConversationTurn(viewer, 'Hello', ID)).toMatchObject({
      created: false,
      uncertain: true,
    });
  });

  it('reads a status turn by its own ID while linking its original task separately', () => {
    reserveConversationTurn(viewer, 'Please prepare a report', ID);
    completeConversationTurn(viewer, ID, 'Drafted the report.', 'answered');
    const status = reserveConversationTurn(viewer, 'Any updates?', NEXT);
    expect(status.routing?.kind).toBe('status');
    const snapshot = readFrontDeskRequest(viewer, NEXT);
    expect(snapshot).toMatchObject({ requestId: NEXT, replyStatus: 'answered' });
    expect(snapshot?.work[0]).toMatchObject({ id: ID, sourceStatus: 'answered' });
    expect(snapshot?.work[0]).not.toHaveProperty('executionStatus');
  });

  it('returns no result for unknown IDs and fails closed for malformed IDs', () => {
    expect(readFrontDeskRequest(viewer, ID)).toBeUndefined();
    expect(() => readFrontDeskRequest(viewer, '../other')).toThrow('invalid_history');
    expect(() => readFrontDeskRequest({ ...viewer, source: 'anonymous' }, ID)).toThrow(
      'identity_required'
    );
  });

  it('does not invent an artifact from a completed conversational reply', () => {
    reserveConversationTurn(viewer, 'Hello', ID);
    completeConversationTurn(viewer, ID, 'Done.');
    expect(
      readFrontDeskRequestArtifact(viewer, {
        request_id: ID,
        revision: 1,
        sha256: 'a'.repeat(64),
      })
    ).toBeUndefined();
  });
});
