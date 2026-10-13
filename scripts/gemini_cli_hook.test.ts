import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireCoSessionLease,
  clearCoSessionNamespace,
  clearCoSessionStore,
  createCoSessionHandoff,
  setCoSessionNamespace,
  startCoSession,
} from '@agent/core/co-session';
import { handleGeminiHookEvent, parseGeminiHookPayload } from './gemini_cli_hook.js';

beforeEach(() => {
  setCoSessionNamespace(`gemini-hook-test-${process.pid}`);
  clearCoSessionStore();
});

afterEach(() => {
  clearCoSessionStore();
  clearCoSessionNamespace();
});

describe('parseGeminiHookPayload', () => {
  it('parses hook event JSON and tolerates garbage', () => {
    expect(parseGeminiHookPayload('{"session_id":"s1","tool_name":"write_file"}')).toEqual({
      session_id: 's1',
      tool_name: 'write_file',
    });
    expect(parseGeminiHookPayload('not json')).toEqual({});
    expect(parseGeminiHookPayload('')).toEqual({});
  });
});

describe('handleGeminiHookEvent', () => {
  it('SessionStart stays silent without a co-session', () => {
    expect(handleGeminiHookEvent('SessionStart', { session_id: 'g1' })).toBeUndefined();
  });

  it('SessionStart joins the sticky session and injects context', () => {
    startCoSession({ goal: 'x', provider: 'claude', session_id: 'cos-g1' });
    const out = handleGeminiHookEvent('SessionStart', { session_id: 'g-9' });
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('cos-g1');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('gemini-g-9');
  });

  it('BeforeAgent injects pending handoffs addressed to gemini', () => {
    startCoSession({ goal: 'x', provider: 'claude', session_id: 'cos-g2' });
    createCoSessionHandoff({
      session_id: 'cos-g2',
      kind: 'workitem.handoff',
      from_provider: 'claude',
      to_provider: 'gemini',
      subject: 'lease handoff',
      body: 'please take over',
    });
    const out = handleGeminiHookEvent('BeforeAgent', { session_id: 'g-1' });
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('lease handoff');
  });

  it('BeforeAgent is silent when nothing is pending', () => {
    startCoSession({ goal: 'x', provider: 'claude', session_id: 'cos-g3' });
    expect(handleGeminiHookEvent('BeforeAgent', { session_id: 'g-1' })).toBeUndefined();
  });

  it('BeforeTool denies a write to a path leased by another participant', () => {
    startCoSession({ goal: 'x', provider: 'claude', session_id: 'cos-g4' });
    acquireCoSessionLease({
      session_id: 'cos-g4',
      provider: 'claude',
      path: 'libs/core/co-session.ts',
      participant_id: 'claude-owner',
    });
    const out = handleGeminiHookEvent('BeforeTool', {
      session_id: 'g-1',
      tool_name: 'write_file',
      tool_input: { file_path: 'libs/core/co-session.ts', content: 'x' },
    });
    const parsed = JSON.parse(out!);
    expect(parsed.decision).toBe('deny');
    expect(parsed.reason).toContain('claude-owner');
  });

  it('BeforeTool allows unleased paths and non-write tools', () => {
    startCoSession({ goal: 'x', provider: 'claude', session_id: 'cos-g5' });
    expect(
      handleGeminiHookEvent('BeforeTool', {
        session_id: 'g-1',
        tool_name: 'write_file',
        tool_input: { file_path: 'libs/core/co-session.ts' },
      })
    ).toBeUndefined();
    expect(
      handleGeminiHookEvent('BeforeTool', {
        session_id: 'g-1',
        tool_name: 'read_file',
        tool_input: { file_path: 'libs/core/co-session.ts' },
      })
    ).toBeUndefined();
  });

  it('SessionEnd releases the participant’s leases', () => {
    startCoSession({ goal: 'x', provider: 'claude', session_id: 'cos-g6' });
    acquireCoSessionLease({
      session_id: 'cos-g6',
      provider: 'gemini',
      path: 'libs/core/co-session.ts',
      participant_id: 'gemini-g-7',
    });
    handleGeminiHookEvent('SessionEnd', { session_id: 'g-7' });
    expect(
      handleGeminiHookEvent('BeforeTool', {
        session_id: 'anyone',
        tool_name: 'write_file',
        tool_input: { file_path: 'libs/core/co-session.ts' },
      })
    ).toBeUndefined();
  });
});
