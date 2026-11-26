import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordSpy = vi.fn((entry: Record<string, unknown>) => ({ id: 'AUD-TEST-1', ...entry }));
vi.mock('../governance/audit-chain.js', () => ({
  auditChain: { record: (e: Record<string, unknown>) => recordSpy(e) },
}));
vi.mock('./co-session-hook.js', () => ({
  coSessionHookDrain: () => [],
  coSessionHookEnd: () => ({ released_leases: 0 }),
  coSessionHookJoin: () => ({ joined: false }),
  coSessionHookLeaseGate: () => ({ decision: 'allow' }),
  formatPendingHandoffs: () => '',
}));

import { writeJson } from '../foundation/json.js';
import { safeExistsSync, safeMkdir, safeRmSync } from '../secure-io.js';
import * as path from 'node:path';
import { buildUserPromptSubmitContext, recordPostToolUse } from './claude-code-hook.js';
import {
  loadSessionLengthState,
  recordSessionPromptForNudge,
  recordSessionToolEventForNudge,
  SESSION_LENGTH_PROMPT_THRESHOLD,
  SESSION_LENGTH_RENUDGE_EVERY_PROMPTS,
  SESSION_LENGTH_TOOL_THRESHOLD,
  sessionLengthStatePath,
  shouldNudgeSessionLength,
  type SessionLengthState,
} from './session-length-nudge.js';

const HOST_ENV_KEYS = ['DEVIN_PROJECT_DIR', 'CHISEL_SESSION_DB', 'AI_AGENT'] as const;
let savedHostEnv: Record<string, string | undefined>;
let sessionId: string;

function seed(state: Partial<SessionLengthState>): void {
  const filePath = sessionLengthStatePath('claude', sessionId)!;
  safeMkdir(path.dirname(filePath), { recursive: true });
  writeJson(filePath, {
    version: 1,
    session_id: sessionId,
    prompts: 0,
    tool_events: 0,
    last_nudged_prompt: null,
    updated_at: new Date().toISOString(),
    ...state,
  });
}

beforeEach(() => {
  savedHostEnv = Object.fromEntries(HOST_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of HOST_ENV_KEYS) delete process.env[k];
  sessionId = `nudge-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  recordSpy.mockClear();
});

afterEach(() => {
  for (const k of HOST_ENV_KEYS) {
    if (savedHostEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedHostEnv[k];
  }
  const filePath = sessionLengthStatePath('claude', sessionId);
  if (filePath && safeExistsSync(filePath)) safeRmSync(filePath, { force: true });
});

function state(partial: Partial<SessionLengthState>): SessionLengthState {
  return {
    version: 1,
    session_id: 's',
    prompts: 0,
    tool_events: 0,
    last_nudged_prompt: null,
    updated_at: '',
    ...partial,
  };
}

describe('shouldNudgeSessionLength', () => {
  it('fires at either threshold and then only every re-nudge interval', () => {
    expect(shouldNudgeSessionLength(state({ prompts: SESSION_LENGTH_PROMPT_THRESHOLD - 1 }))).toBe(
      false
    );
    expect(shouldNudgeSessionLength(state({ prompts: SESSION_LENGTH_PROMPT_THRESHOLD }))).toBe(
      true
    );
    expect(
      shouldNudgeSessionLength(state({ prompts: 10, tool_events: SESSION_LENGTH_TOOL_THRESHOLD }))
    ).toBe(true);
    expect(
      shouldNudgeSessionLength(
        state({
          prompts: SESSION_LENGTH_PROMPT_THRESHOLD + SESSION_LENGTH_RENUDGE_EVERY_PROMPTS - 1,
          last_nudged_prompt: SESSION_LENGTH_PROMPT_THRESHOLD,
        })
      )
    ).toBe(false);
    expect(
      shouldNudgeSessionLength(
        state({
          prompts: SESSION_LENGTH_PROMPT_THRESHOLD + SESSION_LENGTH_RENUDGE_EVERY_PROMPTS,
          last_nudged_prompt: SESSION_LENGTH_PROMPT_THRESHOLD,
        })
      )
    ).toBe(true);
  });
});

describe('per-session counters', () => {
  it('counts prompts and tool events and emits the hint exactly at the threshold', () => {
    seed({ prompts: SESSION_LENGTH_PROMPT_THRESHOLD - 2 });
    expect(recordSessionPromptForNudge('claude', sessionId)).toBeNull();
    const hint = recordSessionPromptForNudge('claude', sessionId);
    expect(hint).toMatch(/handoff note/);
    expect(hint).toMatch(/\/clear/);
    expect(recordSessionPromptForNudge('claude', sessionId)).toBeNull();
    recordSessionToolEventForNudge('claude', sessionId);
    expect(loadSessionLengthState('claude', sessionId)).toMatchObject({
      prompts: SESSION_LENGTH_PROMPT_THRESHOLD + 1,
      tool_events: 1,
      last_nudged_prompt: SESSION_LENGTH_PROMPT_THRESHOLD,
    });
  });

  it('never throws and ignores unusable session ids', () => {
    expect(recordSessionPromptForNudge('claude', undefined)).toBeNull();
    expect(recordSessionPromptForNudge('claude', '../../etc/passwd')).toBeNull();
    expect(() => recordSessionToolEventForNudge('claude', 42)).not.toThrow();
    expect(sessionLengthStatePath('claude', '../x')).toBeNull();
  });

  it('starts fresh on a corrupt or foreign state file', () => {
    seed({ session_id: 'someone-else', prompts: 999 });
    expect(recordSessionPromptForNudge('claude', sessionId)).toBeNull();
    expect(loadSessionLengthState('claude', sessionId)?.prompts).toBe(1);
  });
});

describe('claude-code hook wiring', () => {
  it('adds the handoff hint to UserPromptSubmit once the session crosses the threshold', () => {
    seed({ prompts: SESSION_LENGTH_PROMPT_THRESHOLD - 1 });
    const context = buildUserPromptSubmitContext({ prompt: 'hello', session_id: sessionId });
    expect(context).toContain('Next-step hints:');
    expect(context).toMatch(/This session is long \(150 prompts/);
    expect(recordSpy.mock.calls.at(-1)?.[0].metadata.session_length_nudge).toBe(true);
  });

  it('does not add the hint for a short session', () => {
    const context = buildUserPromptSubmitContext({ prompt: 'hello', session_id: sessionId });
    expect(context).not.toMatch(/This session is long/);
  });

  it('counts audited tool events from PostToolUse', () => {
    recordPostToolUse({ tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: sessionId });
    recordPostToolUse({ tool_name: 'Read', tool_input: {}, session_id: sessionId });
    expect(loadSessionLengthState('claude', sessionId)?.tool_events).toBe(1);
  });
});
