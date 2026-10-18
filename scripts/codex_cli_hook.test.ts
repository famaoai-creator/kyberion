import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireCoSessionLease,
  clearCoSessionNamespace,
  clearCoSessionStore,
  createCoSessionHandoff,
  getCoSessionLease,
  listCoSessionHandoffs,
  listCoSessionPresence,
  setCoSessionNamespace,
  startCoSession,
} from '@agent/core/co-session';
import { handleCodexHookEvent } from './codex_cli_hook.js';

beforeEach(() => {
  setCoSessionNamespace(`codex-hook-test-${process.pid}`);
  clearCoSessionStore();
});
afterEach(() => {
  clearCoSessionStore();
  clearCoSessionNamespace();
});

describe('Codex co-session hooks', () => {
  it('stays silent with no active session or stable CLI identity', () => {
    expect(handleCodexHookEvent('SessionStart', { session_id: 'a' })).toBeUndefined();
    startCoSession({ goal: 'shared checkout', provider: 'claude', session_id: 'cos-codex' });
    for (const session_id of [undefined, 1, {}, '']) {
      expect(handleCodexHookEvent('UserPromptSubmit', { session_id })).toBeUndefined();
    }
  });

  it('joins with stable identity and injects only newly received handoffs at safe points', () => {
    startCoSession({ goal: 'shared checkout', provider: 'claude', session_id: 'cos-codex' });
    const payload = { session_id: 'thread-a' };
    expect(handleCodexHookEvent('SessionStart', payload)).toContain('codex-thread-a');
    expect(listCoSessionPresence().some((p) => p.participant_id === 'codex-thread-a')).toBe(true);
    const handoff = createCoSessionHandoff({
      kind: 'review.request',
      from_provider: 'claude',
      to_provider: 'codex',
      body: 'Review this',
      subject: 'one review',
    });
    const output = JSON.parse(handleCodexHookEvent('PostToolUse', payload)!);
    expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(output.hookSpecificOutput.additionalContext).toContain(handoff.handoff_id);
    for (let i = 0; i < 5; i++) {
      expect(handleCodexHookEvent('PostToolUse', payload)).toBeUndefined();
      expect(handleCodexHookEvent('UserPromptSubmit', payload)).toBeUndefined();
    }
    expect(listCoSessionHandoffs(undefined, { pendingOnly: true })).toHaveLength(1);
    // Another instance of the same CLI still receives the provider broadcast.
    expect(handleCodexHookEvent('UserPromptSubmit', { session_id: 'thread-b' })).toContain(
      handoff.handoff_id
    );
  });

  it('does not echo own messages or receive another participant request', () => {
    startCoSession({ goal: 'x', provider: 'claude', session_id: 'cos-codex' });
    createCoSessionHandoff({
      kind: 'notification.publish',
      from_provider: 'codex',
      from_participant_id: 'codex-a',
      body: 'self',
    });
    createCoSessionHandoff({
      kind: 'review.request',
      from_provider: 'claude',
      to_provider: 'codex',
      to_participant_id: 'codex-b',
      body: 'other instance',
    });
    expect(handleCodexHookEvent('UserPromptSubmit', { session_id: 'a' })).toBeUndefined();
  });

  it('does not lose overflow when receipt batches are bounded', () => {
    startCoSession({ goal: 'x', provider: 'claude', session_id: 'cos-codex' });
    const ids = Array.from(
      { length: 12 },
      (_, i) =>
        createCoSessionHandoff({
          kind: 'review.request',
          from_provider: 'claude',
          to_provider: 'codex',
          subject: `review ${i}`,
          body: 'x',
        }).handoff_id
    );
    const first = handleCodexHookEvent('UserPromptSubmit', { session_id: 'a' })!;
    const second = handleCodexHookEvent('PostToolUse', { session_id: 'a' })!;
    for (const id of ids) expect(Number(first.includes(id)) + Number(second.includes(id))).toBe(1);
    expect(handleCodexHookEvent('PostToolUse', { session_id: 'a' })).toBeUndefined();
  });

  it('keeps Stop inert and releases leases only on SessionEnd', () => {
    startCoSession({ goal: 'x', provider: 'claude', session_id: 'cos-codex' });
    acquireCoSessionLease({
      provider: 'codex',
      participant_id: 'codex-a',
      path: 'scripts/codex_cli_hook.ts',
    });
    for (const stop_hook_active of [false, true])
      expect(handleCodexHookEvent('Stop', { session_id: 'a', stop_hook_active })).toBeUndefined();
    expect(getCoSessionLease(undefined, 'scripts/codex_cli_hook.ts').lease?.status).toBe('active');
    expect(handleCodexHookEvent('SessionEnd', { session_id: 'a' })).toBeUndefined();
    expect(getCoSessionLease(undefined, 'scripts/codex_cli_hook.ts').lease?.status).toBe(
      'released'
    );
  });
});
