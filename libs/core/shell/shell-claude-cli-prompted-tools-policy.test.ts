import { describe, expect, it, vi } from 'vitest';

// The governed opt-in decides exposure when no explicit option is passed.
const { policyEnabled } = vi.hoisted(() => ({ policyEnabled: { value: true } }));
vi.mock('../reasoning/reasoning-backend-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reasoning/reasoning-backend-policy.js')>();
  return {
    ...actual,
    isPromptedToolCallingEnabled: (mode: string) => mode === 'claude-cli' && policyEnabled.value,
  };
});

import { ShellClaudeCliBackend } from './shell-claude-cli-backend.js';

describe('claude-cli prompted tool calling — governed opt-in', () => {
  it('policy off → no generateWithTools; policy on → exposed', () => {
    policyEnabled.value = false;
    expect(new ShellClaudeCliBackend({ bin: 'claude' }).generateWithTools).toBeUndefined();
    policyEnabled.value = true;
    expect(typeof new ShellClaudeCliBackend({ bin: 'claude' }).generateWithTools).toBe('function');
  });

  it('the shipped policy validates and enables only claude-cli', async () => {
    const actual = await vi.importActual<typeof import('../reasoning/reasoning-backend-policy.js')>(
      '../reasoning/reasoning-backend-policy.js'
    );
    expect(actual.loadReasoningBackendPolicy().prompted_tool_calling).toEqual({
      'claude-cli': true,
    });
    expect(actual.isPromptedToolCallingEnabled('claude-cli')).toBe(true);
    expect(actual.isPromptedToolCallingEnabled('codex-cli')).toBe(false);
  });
});
