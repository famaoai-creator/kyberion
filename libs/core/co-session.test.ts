import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireCoSessionLease,
  ackCoSessionHandoff,
  appendCoSessionBlackboard,
  buildCoSessionPromoteHint,
  clearCoSessionNamespace,
  clearCoSessionStore,
  createCoSessionHandoff,
  getCoSessionStatus,
  joinCoSession,
  leaveCoSession,
  listCoSessionHandoffs,
  listCoSessionLeases,
  normalizeCoSessionPath,
  releaseCoSessionLease,
  setCoSessionNamespace,
  startCoSession,
  CoSessionError,
} from './co-session.js';

beforeEach(() => {
  setCoSessionNamespace(`co-session-test-${process.pid}`);
  clearCoSessionStore();
});

afterEach(() => {
  clearCoSessionStore();
  clearCoSessionNamespace();
});

describe('co-session', () => {
  it('starts a sticky session and shows multi-provider presence', () => {
    const session = startCoSession({
      goal: 'coordinate five CLIs',
      provider: 'claude',
      session_id: 'cos-test-1',
    });
    expect(session.status).toBe('open');
    joinCoSession({ session_id: session.session_id, provider: 'cursor' });
    joinCoSession({ session_id: session.session_id, provider: 'grok' });
    const status = getCoSessionStatus(session.session_id);
    expect(status.sticky).toBe(true);
    expect(status.presence.map((row) => row.provider).sort()).toEqual(['claude', 'cursor', 'grok']);
  });

  it('enforces single-writer path leases', () => {
    startCoSession({ goal: 'lease check', provider: 'claude', session_id: 'cos-lease' });
    const lease = acquireCoSessionLease({
      session_id: 'cos-lease',
      provider: 'claude',
      path: 'scripts/co_session.ts',
      participant_id: 'claude-1',
    });
    expect(lease.status).toBe('active');
    expect(() =>
      acquireCoSessionLease({
        session_id: 'cos-lease',
        provider: 'cursor',
        path: 'scripts/co_session.ts',
        participant_id: 'cursor-1',
      })
    ).toThrow(CoSessionError);
    releaseCoSessionLease({
      session_id: 'cos-lease',
      provider: 'claude',
      path: 'scripts/co_session.ts',
      participant_id: 'claude-1',
    });
    const again = acquireCoSessionLease({
      session_id: 'cos-lease',
      provider: 'cursor',
      path: 'scripts/co_session.ts',
      participant_id: 'cursor-1',
    });
    expect(again.holder_provider).toBe('cursor');
  });

  it('records Mesh-aligned handoffs and ack', () => {
    startCoSession({ goal: 'handoff check', provider: 'claude', session_id: 'cos-hand' });
    const handoff = createCoSessionHandoff({
      session_id: 'cos-hand',
      kind: 'workitem.handoff',
      from_provider: 'claude',
      to_provider: 'codex',
      subject: 'scripts/co_session.ts',
      body: 'please implement lease renew',
    });
    expect(listCoSessionHandoffs('cos-hand', { pendingOnly: true })).toHaveLength(1);
    const acked = ackCoSessionHandoff({
      session_id: 'cos-hand',
      handoff_id: handoff.handoff_id,
      provider: 'codex',
    });
    expect(acked.acked_by).toBe('codex');
    expect(listCoSessionHandoffs('cos-hand', { pendingOnly: true })).toHaveLength(0);
  });

  it('targets a specific participant when the same provider appears twice', () => {
    startCoSession({ goal: 'same model', provider: 'claude', session_id: 'cos-twin' });
    joinCoSession({
      session_id: 'cos-twin',
      provider: 'claude',
      participant_id: 'claude-a',
    });
    joinCoSession({
      session_id: 'cos-twin',
      provider: 'claude',
      participant_id: 'claude-b',
    });
    const handoff = createCoSessionHandoff({
      session_id: 'cos-twin',
      kind: 'review.request',
      from_provider: 'cursor',
      from_participant_id: 'cursor-1',
      to_provider: 'claude',
      to_participant_id: 'claude-b',
      body: 'only b should ack',
    });
    expect(
      listCoSessionHandoffs('cos-twin', {
        pendingOnly: true,
        to_provider: 'claude',
        to_participant_id: 'claude-b',
      })
    ).toHaveLength(1);
    expect(() =>
      ackCoSessionHandoff({
        session_id: 'cos-twin',
        handoff_id: handoff.handoff_id,
        provider: 'claude',
        participant_id: 'claude-a',
      })
    ).toThrow(/not claude-a/);
    const acked = ackCoSessionHandoff({
      session_id: 'cos-twin',
      handoff_id: handoff.handoff_id,
      provider: 'claude',
      participant_id: 'claude-b',
    });
    expect(acked.acked_by_participant_id).toBe('claude-b');
  });

  it('appends blackboard notes and leaves releasing own leases', () => {
    startCoSession({ goal: 'board', provider: 'agy', session_id: 'cos-board' });
    appendCoSessionBlackboard({
      session_id: 'cos-board',
      provider: 'agy',
      text: 'investigating CI',
    });
    acquireCoSessionLease({
      session_id: 'cos-board',
      provider: 'agy',
      path: 'libs/core/co-session.ts',
      participant_id: 'agy-9',
    });
    const left = leaveCoSession({
      session_id: 'cos-board',
      provider: 'agy',
      participant_id: 'agy-9',
    });
    expect(left.released_leases).toBe(1);
    expect(listCoSessionLeases('cos-board').every((lease) => lease.status !== 'active')).toBe(true);
  });

  it('rejects path escape and unknown handoff kinds', () => {
    expect(() => normalizeCoSessionPath('../outside')).toThrow(/must not contain/);
    startCoSession({ goal: 'x', provider: 'claude', session_id: 'cos-bad' });
    expect(() =>
      createCoSessionHandoff({
        session_id: 'cos-bad',
        kind: 'shell.exec',
        from_provider: 'claude',
        body: 'nope',
      })
    ).toThrow(/unknown handoff kind/);
  });

  it('emits promote hints that keep peer and mission boundaries', () => {
    startCoSession({ goal: 'promote', provider: 'claude', session_id: 'cos-promo' });
    const hint = buildCoSessionPromoteHint('cos-promo');
    expect(hint.peer_lift).toMatch(/Mesh Hub/);
    expect(hint.mission_lift).toMatch(/mission_controller/);
    expect(hint.note).toMatch(/never writes \.git/);
  });
});
