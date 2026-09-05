import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  loadReasoningBackendPolicy,
  normalizeReasoningBackendMode,
  resolveReasoningBackendSelectionFromContext,
  resolveReasoningBackendModeFromContext,
  resolveScopedBackendPolicy,
} from './reasoning-backend-policy.js';

describe('reasoning-backend-policy', () => {
  it('loads the policy catalog', () => {
    const policy = loadReasoningBackendPolicy();

    expect(policy.default_mode).toBe('claude-cli');
    expect(policy.allowed_modes).toContain('gemini-cli');
    expect(policy.allowed_modes).toContain('gemini-api');
    expect(policy.allowed_modes).toContain('openrouter');
    expect(policy.allowed_modes).toContain('nemotron-api');
    expect(policy.allowed_modes).toContain('copilot');
    expect(policy.allowed_modes).toContain('cursor-cli');
    expect(policy.allowed_modes).toContain('grok-cli');
    expect(policy.allowed_modes).toContain('grok-api');
    expect(policy.mode_aliases['gemini-api']).toBeUndefined();
    expect(policy.mode_aliases.nemotron).toBe('nemotron-api');
    expect(policy.mode_aliases.grok).toBe('grok-cli');
    expect(policy.mode_aliases['grok-build']).toBe('grok-cli');
    expect(policy.mode_aliases.xai).toBe('grok-api');
    expect(policy.provider_fallback_order.map((e) => e.mode)).toContain('grok-cli');
    expect(policy.provider_fallback_order.map((e) => e.mode)).toContain('claude-cli');
    expect(policy.openrouter).toEqual({
      default_profile: 'free-router',
      default_cost_policy: 'free-only',
      required_parameters: ['tools', 'tool_choice'],
    });
  });

  it('keeps the Google AI Studio REST mode distinct from the CLI mode', () => {
    expect(normalizeReasoningBackendMode('gemini-api')).toBe('gemini-api');
    expect(normalizeReasoningBackendMode('codex-cli')).toBe('codex-cli');
  });

  it('applies project over organization over tenant backend overrides', () => {
    const policy = loadReasoningBackendPolicy();
    const scoped = resolveScopedBackendPolicy(
      {
        ...policy,
        allowed_modes: ['stub'],
        tenant_overrides: { tenant_a: { allowed_modes: ['ollama'] } },
        organization_overrides: { org_a: { allowed_modes: ['codex-cli'] } },
        project_overrides: { project_a: { default_mode: 'claude-cli' } },
      },
      {
        tier: 'confidential',
        tenant_slug: 'tenant_a',
        organization_id: 'org_a',
        project_id: 'project_a',
      }
    );
    expect(scoped.allowed_modes).toEqual(['codex-cli']);
    expect(scoped.default_mode).toBe('claude-cli');
  });

  it('does not select a backend denied by the scoped allow list', () => {
    const policy = loadReasoningBackendPolicy();
    expect(() =>
      resolveReasoningBackendModeFromContext({
        policy: { ...policy, allowed_modes: ['stub'], default_mode: 'claude-cli' },
        env: {},
        providers: [],
      })
    ).toThrow(/REASONING_MODE_DENIED/);
  });

  it('resolves explicit and env-driven backend selection using policy order', () => {
    const policy = loadReasoningBackendPolicy();

    expect(
      resolveReasoningBackendModeFromContext({
        requestedMode: 'claude-agent',
        policy,
        env: {},
        providers: [],
      })
    ).toBe('claude-agent');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {
          ANTHROPIC_API_KEY: 'x',
        },
        providers: [],
      })
    ).toBe('anthropic');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {
          CODEX_CLI: '1',
          TERM_PROGRAM: 'codex',
        },
        providers: [{ provider: 'codex', installed: true, healthy: true }],
      })
    ).toBe('codex-cli');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {},
        providers: [
          { provider: 'codex', installed: false, healthy: false },
          { provider: 'gemini', installed: true, healthy: true },
        ],
      })
    ).toBe('claude-cli');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {},
        providers: [
          { provider: 'codex', installed: false, healthy: false },
          { provider: 'gemini', installed: true, healthy: true },
          { provider: 'agy', installed: true, healthy: true },
        ],
      })
    ).toBe('agy-cli');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: { GEMINI_API_KEY: 'test-gemini-key', GEMINI_CLI: '1' },
        providers: [{ provider: 'gemini', installed: true, healthy: true }],
      })
    ).toBe('gemini-api');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: { AGY_CLI: '1' },
        providers: [{ provider: 'agy', installed: true, healthy: true }],
      })
    ).toBe('agy-cli');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: { GROK_CLI: '1' },
        providers: [{ provider: 'grok', installed: true, healthy: true }],
      })
    ).toBe('grok-cli');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: { XAI_API_KEY: 'xai-test-key' },
        providers: [{ provider: 'grok', installed: true, healthy: true }],
      })
    ).toBe('grok-api');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: { KYBERION_REASONING_BACKEND: 'xai' },
        providers: [],
      })
    ).toBe('grok-api');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {},
        providers: [
          { provider: 'codex', installed: false, healthy: false },
          { provider: 'agy', installed: false, healthy: false },
          { provider: 'grok', installed: true, healthy: true },
        ],
      })
    ).toBe('grok-cli');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {},
        providers: [],
      })
    ).toBe('claude-cli');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {
          OPENROUTER_API_KEY: 'or-key',
        },
        providers: [],
      })
    ).toBe('openrouter');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {
          KYBERION_OPENROUTER_KEY: 'or-key',
        },
        providers: [],
      })
    ).toBe('openrouter');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {
          KYBERION_NEMOTRON_URL: 'https://integrate.api.nvidia.com/v1',
        },
        providers: [],
      })
    ).toBe('nemotron-api');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {
          KYBERION_LOCAL_LLM_URL: 'http://127.0.0.1:11434/v1',
          OPENROUTER_API_KEY: 'or-key',
        },
        providers: [],
      })
    ).toBe('local');

    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: {},
        providers: [{ provider: 'copilot', installed: true, healthy: true }],
      })
    ).toBe('copilot');
  });

  it('returns safe provenance for each selection source without exposing env values', () => {
    const policy = loadReasoningBackendPolicy();
    const selection = resolveReasoningBackendSelectionFromContext({
      policy,
      env: { ANTHROPIC_API_KEY: 'secret-value' },
      providers: [],
    });
    expect(selection.mode).toBe('anthropic');
    expect(selection.reason).toContain('env=ANTHROPIC_API_KEY');
    expect(selection.reason).not.toContain('secret-value');

    const scoped = resolveReasoningBackendSelectionFromContext({
      policy: {
        ...policy,
        default_mode: 'stub',
        project_overrides: { project_a: { default_mode: 'stub' } },
      },
      env: {},
      providers: [],
      scope: {
        tier: 'confidential',
        tenant_slug: 'tenant_a',
        project_id: 'project_a',
      },
    });
    expect(scoped).toEqual({
      mode: 'stub',
      reason: 'policy default_mode=stub; scope overlays=project',
    });
  });

  it('prefers the in-session claude-agent when inside a Claude Code harness (CLAUDECODE)', () => {
    const policy = loadReasoningBackendPolicy();

    // Inside Claude Code with no explicit API-key signal → in-session sub-agent
    // (instead of spawning a CLI / falling back to the default codex-cli).
    expect(
      resolveReasoningBackendModeFromContext({ policy, env: { CLAUDECODE: '1' }, providers: [] })
    ).toBe('claude-agent');

    // Explicit API-key signals still win (conservative placement, last in priority).
    expect(
      resolveReasoningBackendModeFromContext({
        policy,
        env: { CLAUDECODE: '1', ANTHROPIC_API_KEY: 'x' },
        providers: [],
      })
    ).toBe('anthropic');

    // An explicit requested mode always overrides host detection.
    expect(
      resolveReasoningBackendModeFromContext({
        requestedMode: 'codex-cli',
        policy,
        env: { CLAUDECODE: '1' },
        providers: [],
      })
    ).toBe('codex-cli');

    // No CLAUDECODE → the governed default remains the local Claude CLI.
    expect(resolveReasoningBackendModeFromContext({ policy, env: {}, providers: [] })).toBe(
      'claude-cli'
    );
  });

  it('routes runtime environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/reasoning-backend-policy.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });
});
