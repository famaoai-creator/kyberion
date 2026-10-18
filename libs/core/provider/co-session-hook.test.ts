import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const race = vi.hoisted(() => ({ beforeDeliveryLock: undefined as (() => void) | undefined }));
vi.mock('../foundation/lock-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../foundation/lock-utils.js')>();
  return {
    ...actual,
    withLockSync: <T>(id: string, fn: () => T, timeout?: number): T => {
      if (id.startsWith('co-session-delivery:')) {
        const trigger = race.beforeDeliveryLock;
        race.beforeDeliveryLock = undefined;
        trigger?.();
      }
      return actual.withLockSync(id, fn, timeout);
    },
  };
});
import {
  ackCoSessionHandoff,
  acquireCoSessionLease,
  clearCoSessionNamespace,
  clearCoSessionStore,
  createCoSessionHandoff,
  setCoSessionNamespace,
  startCoSession,
} from '../co-session.js';
import {
  coSessionHookDrain,
  coSessionHookEnd,
  coSessionHookJoin,
  coSessionHookLeaseGate,
  formatPendingHandoffs,
  resolveHookParticipantId,
} from './co-session-hook.js';

beforeEach(() => {
  race.beforeDeliveryLock = undefined;
  setCoSessionNamespace(`co-session-hook-test-${process.pid}`);
  clearCoSessionStore();
});

afterEach(() => {
  clearCoSessionStore();
  clearCoSessionNamespace();
});

describe('resolveHookParticipantId', () => {
  it('builds a stable provider-scoped participant id', () => {
    expect(resolveHookParticipantId('claude', 'abc-123')).toBe('claude-abc-123');
    expect(resolveHookParticipantId('gemini', 'weird key!')).toBe('gemini-weird-key-');
  });
});

describe('coSessionHookJoin', () => {
  it('returns joined:false when no co-session exists', () => {
    const result = coSessionHookJoin({ provider: 'claude', session_key: 's1' });
    expect(result.joined).toBe(false);
  });

  it('joins the sticky session when one exists', () => {
    startCoSession({ goal: 'x', provider: 'codex', session_id: 'cos-hook-1' });
    const result = coSessionHookJoin({ provider: 'claude', session_key: 'sess-42' });
    expect(result.joined).toBe(true);
    expect(result.participant_id).toBe('claude-sess-42');
  });

  it('rejects an unknown provider quietly', () => {
    startCoSession({ goal: 'x', provider: 'codex', session_id: 'cos-hook-2' });
    expect(coSessionHookJoin({ provider: 'emacs', session_key: 's' }).joined).toBe(false);
  });
});

describe('coSessionHookDrain + formatPendingHandoffs', () => {
  it('refreshes pending inside the receipt lock after a competing hook delivered newer work', () => {
    startCoSession({ goal: 'race', provider: 'claude', session_id: 'cos-hook-race' });
    const old = createCoSessionHandoff({
      kind: 'review.request',
      from_provider: 'claude',
      to_provider: 'codex',
      body: 'old',
    });
    const input = { provider: 'codex', session_key: 'race', only_new: true };
    let delivered: string | undefined;
    // Interleave after A begins but before its receipt lock: ack old work,
    // append new work, and let hook B deliver it first.
    race.beforeDeliveryLock = () => {
      ackCoSessionHandoff({
        provider: 'codex',
        participant_id: 'codex-race',
        handoff_id: old.handoff_id,
      });
      const fresh = createCoSessionHandoff({
        kind: 'review.request',
        from_provider: 'claude',
        to_provider: 'codex',
        body: 'new',
      });
      delivered = coSessionHookDrain(input)?.handoffs[0]?.handoff_id;
      expect(delivered).toBe(fresh.handoff_id);
    };
    expect(coSessionHookDrain(input)?.handoffs).toEqual([]);
    expect(delivered).toBeDefined();
    expect(coSessionHookDrain(input)?.handoffs).toEqual([]);
  });
  it('surfaces handoffs addressed to the participant, provider, or broadcast', () => {
    startCoSession({ goal: 'x', provider: 'claude', session_id: 'cos-hook-3' });
    createCoSessionHandoff({
      session_id: 'cos-hook-3',
      kind: 'workitem.handoff',
      from_provider: 'claude',
      to_provider: 'gemini',
      subject: 'shared file',
      body: 'take this file',
    });
    createCoSessionHandoff({
      session_id: 'cos-hook-3',
      kind: 'notification.publish',
      from_provider: 'claude',
      body: 'broadcast note',
    });
    createCoSessionHandoff({
      session_id: 'cos-hook-3',
      kind: 'review.request',
      from_provider: 'claude',
      to_provider: 'codex',
      body: 'not for gemini',
    });

    const digest = coSessionHookDrain({ provider: 'gemini', session_key: 'g1' });
    expect(digest?.handoffs).toHaveLength(2);
    const block = formatPendingHandoffs(digest);
    expect(block).toContain('pending handoff');
    expect(block).toContain('handoff');
    expect(block).toContain('gemini-g1');
  });

  it('returns undefined when no session exists', () => {
    expect(coSessionHookDrain({ provider: 'claude', session_key: 'x' })).toBeUndefined();
  });
});

describe('coSessionHookLeaseGate', () => {
  it('denies a write to a path leased by another participant', () => {
    startCoSession({ goal: 'x', provider: 'claude', session_id: 'cos-hook-4' });
    acquireCoSessionLease({
      session_id: 'cos-hook-4',
      provider: 'claude',
      path: 'libs/core/co-session.ts',
      participant_id: 'claude-owner',
    });

    const denied = coSessionHookLeaseGate({
      provider: 'gemini',
      session_key: 'other',
      file_path: 'libs/core/co-session.ts',
    });
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toContain('claude-owner');

    const own = coSessionHookLeaseGate({
      provider: 'claude',
      file_path: 'libs/core/co-session.ts',
      participant_id: 'claude-owner',
    });
    expect(own.decision).toBe('allow');

    const free = coSessionHookLeaseGate({
      provider: 'gemini',
      session_key: 'other',
      file_path: 'scripts/co_session.ts',
    });
    expect(free.decision).toBe('allow');
  });

  it('fails open when no session exists', () => {
    expect(
      coSessionHookLeaseGate({ provider: 'claude', file_path: 'libs/core/co-session.ts' }).decision
    ).toBe('allow');
  });
});

describe('coSessionHookEnd', () => {
  it('releases the participant’s active leases on session end', () => {
    startCoSession({ goal: 'x', provider: 'claude', session_id: 'cos-hook-5' });
    acquireCoSessionLease({
      session_id: 'cos-hook-5',
      provider: 'gemini',
      path: 'libs/core/co-session.ts',
      participant_id: 'gemini-s9',
    });
    const ended = coSessionHookEnd({
      provider: 'gemini',
      session_key: 's9',
    });
    expect(ended.released_leases).toBe(1);
    expect(
      coSessionHookLeaseGate({
        provider: 'claude',
        session_key: 'anyone',
        file_path: 'libs/core/co-session.ts',
      }).decision
    ).toBe('allow');
  });
});
