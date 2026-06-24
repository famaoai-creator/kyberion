import { describe, expect, it } from 'vitest';
import {
  loadReasoningBackendPolicy,
  normalizeReasoningBackendMode,
  resolveReasoningBackendModeFromContext,
} from './reasoning-backend-policy.js';

describe('reasoning-backend-policy', () => {
  it('loads the policy catalog', () => {
    const policy = loadReasoningBackendPolicy();

    expect(policy.default_mode).toBe('codex-cli');
    expect(policy.allowed_modes).toContain('gemini-cli');
    expect(policy.allowed_modes).toContain('openrouter');
    expect(policy.allowed_modes).toContain('nemotron-api');
    expect(policy.mode_aliases['gemini-api']).toBe('gemini-cli');
    expect(policy.mode_aliases.nemotron).toBe('nemotron-api');
  });

  it('normalizes deprecated mode aliases', () => {
    expect(normalizeReasoningBackendMode('gemini-api')).toBe('gemini-cli');
    expect(normalizeReasoningBackendMode('codex-cli')).toBe('codex-cli');
  });

  it('resolves explicit and env-driven backend selection using policy order', () => {
    const policy = loadReasoningBackendPolicy();

    expect(
      resolveReasoningBackendModeFromContext({
        requestedMode: 'claude-agent',
        policy,
        env: {},
        providers: [],
      }),
    ).toBe('claude-agent');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {
          ANTHROPIC_API_KEY: 'x',
        },
        providers: [],
      }),
    ).toBe('anthropic');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {
          CODEX_CLI: '1',
          TERM_PROGRAM: 'codex',
        },
        providers: [{ provider: 'codex', installed: true, healthy: true }],
      }),
    ).toBe('codex-cli');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {},
        providers: [
          { provider: 'codex', installed: false, healthy: false },
          { provider: 'gemini', installed: true, healthy: true },
        ],
      }),
    ).toBe('gemini-cli');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {},
        providers: [],
      }),
    ).toBe('codex-cli');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {
          OPENROUTER_API_KEY: 'or-key',
        },
        providers: [],
      }),
    ).toBe('openrouter');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {
          KYBERION_NEMOTRON_URL: 'https://integrate.api.nvidia.com/v1',
        },
        providers: [],
      }),
    ).toBe('nemotron-api');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {
          KYBERION_LOCAL_LLM_URL: 'http://127.0.0.1:11434/v1',
          OPENROUTER_API_KEY: 'or-key',
        },
        providers: [],
      }),
    ).toBe('local');
  });
});
