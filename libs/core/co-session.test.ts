import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireCoSessionLease,
  ackCoSessionHandoff,
  appendCoSessionBlackboard,
  buildCoSessionPromoteHint,
  clearCoSessionNamespace,
  clearCoSessionStore,
  closeCoSession,
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
import { registerLockIo, type LockIo } from './foundation/lock-utils.js';
import { readJsonLines } from './foundation/json.js';
import { pathResolver } from './path-resolver.js';

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

  it('serializes lease mutations through the shared inter-process lock', () => {
    // The lease read-check-write must run inside withLockSync — otherwise two
    // processes racing on the same path can both observe "free" and acquire.
    // A recording LockIo proves the lock file is touched around the mutation.
    const previous = registerLockIo(undefined);
    const published: string[] = [];
    const files = new Map<string, string>();
    const io: LockIo = {
      exists: (filePath) => files.has(filePath) || filePath.endsWith('locks'),
      mkdir: () => {},
      createExclusive: (filePath, content) => {
        if (files.has(filePath)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        files.set(filePath, content);
        published.push(filePath);
      },
      publishExclusive: (filePath, content) => {
        if (files.has(filePath)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        files.set(filePath, content);
        published.push(filePath);
      },
      unlink: (filePath) => {
        files.delete(filePath);
      },
      loadJson: (filePath) => JSON.parse(files.get(filePath) ?? 'null'),
    };
    registerLockIo(io);
    try {
      startCoSession({ goal: 'lock check', provider: 'claude', session_id: 'cos-lock' });
      acquireCoSessionLease({
        session_id: 'cos-lock',
        provider: 'claude',
        path: 'libs/core/co-session.ts',
        participant_id: 'claude-1',
      });
      const leaseLocks = published.filter((file) =>
        decodeURIComponent(file).includes('co-session-lease:')
      );
      expect(leaseLocks).toHaveLength(1);
      expect(decodeURIComponent(leaseLocks[0]!)).toContain('cos-lock:');
      // The lock is released after the mutation so a second participant proceeds.
      releaseCoSessionLease({
        session_id: 'cos-lock',
        provider: 'claude',
        path: 'libs/core/co-session.ts',
        participant_id: 'claude-1',
      });
      expect(
        published.filter((file) => decodeURIComponent(file).includes('co-session-lease:'))
      ).toHaveLength(2);
    } finally {
      registerLockIo(previous);
    }
  });

  it('refuses lease acquisition on a closed session', () => {
    startCoSession({ goal: 'x', provider: 'claude', session_id: 'cos-closed' });
    closeCoSession({ session_id: 'cos-closed', provider: 'claude' });
    expect(() =>
      acquireCoSessionLease({
        session_id: 'cos-closed',
        provider: 'claude',
        path: 'libs/core/co-session.ts',
      })
    ).toThrow(/closed/);
  });

  it('leaveCoSession on a closed session is quiet and non-throwing', () => {
    startCoSession({ goal: 'x', provider: 'claude', session_id: 'cos-leave-closed' });
    joinCoSession({
      provider: 'claude',
      participant_id: 'claude-p1',
      session_id: 'cos-leave-closed',
    });
    closeCoSession({ session_id: 'cos-leave-closed', provider: 'claude' });
    const result = leaveCoSession({
      provider: 'claude',
      participant_id: 'claude-p1',
      session_id: 'cos-leave-closed',
    });
    expect(result.released_leases).toBe(0);
    const events = readJsonLines<Record<string, unknown>>(
      pathResolver.rootResolve(
        `active/shared/observability/co-sessions/co-session-test-${process.pid}/cos-leave-closed/events.jsonl`
      )
    );
    expect(events.filter((e) => e.event === 'session_left')).toHaveLength(0);
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
