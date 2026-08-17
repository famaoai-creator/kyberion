import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveReasoningRoute,
  resolveSamplingParams,
  normalizeReasoningRole,
  resolveStepReasoningRoute,
  resetReasoningRoutePolicyCache,
} from './reasoning-route-resolver.js';

describe('reasoning-route-resolver', () => {
  afterEach(() => {
    resetReasoningRoutePolicyCache();
  });

  it('resolves role, profile, model and provenance deterministically', () => {
    const route = resolveReasoningRoute({ role: 'code-architect', env: {} });
    expect(route.role).toBe('code_architect');
    expect(route.profileRef).toBe('code-architect-claude');
    expect(route.mode).toBe('anthropic');
    expect(route.provenance).toEqual(
      expect.arrayContaining([{ source: 'policy', field: 'roles.code_architect' }])
    );
  });

  it('accepts explicit role bindings without allowing arbitrary roles', () => {
    const route = resolveReasoningRoute({
      role: 'subagent',
      env: { KYBERION_REASONING_ROLE_SUBAGENT: 'ollama:Agents-A1-4B' },
    });
    expect(route.mode).toBe('ollama');
    expect(route.model).toBe('Agents-A1-4B');
    expect(() => normalizeReasoningRole('unknown-role')).toThrow(/Allowed roles/);
  });

  it('normalizes an unprefixed Gemini model env value through the approved model registry', () => {
    const route = resolveReasoningRoute({
      role: 'default',
      requestedProfile: 'gemini-api-default',
      env: {
        GEMINI_API_KEY: 'test-gemini-key',
        KYBERION_GEMINI_MODEL: 'gemini-flash-latest',
      },
    });
    expect(route.mode).toBe('gemini-api');
    expect(route.model).toBe('gemini:gemini-flash-latest');
    expect(route.capabilities).toEqual(expect.arrayContaining(['tools', 'vision', 'streaming']));
  });

  it('resolves the grok-api default profile against the approved xAI model', () => {
    const route = resolveReasoningRoute({
      role: 'default',
      requestedProfile: 'grok-api-default',
      env: { XAI_API_KEY: 'xai-test-key' },
    });
    expect(route.mode).toBe('grok-api');
    expect(route.model).toBe('xai:grok-4.6');
    expect(route.capabilities).toEqual(expect.arrayContaining(['tools', 'vision']));
  });

  it('pins Claude default profiles and honors Anthropic model overrides', () => {
    const route = resolveReasoningRoute({
      role: 'default',
      requestedProfile: 'anthropic-default',
      env: { ANTHROPIC_API_KEY: 'test-anthropic-key' },
    });
    expect(route.model).toBe('anthropic:claude-opus-5');

    const overridden = resolveReasoningRoute({
      role: 'default',
      requestedProfile: 'anthropic-default',
      env: {
        ANTHROPIC_API_KEY: 'test-anthropic-key',
        KYBERION_ANTHROPIC_MODEL: 'claude-opus-4-8',
      },
    });
    expect(overridden.model).toBe('anthropic:claude-opus-4-8');
  });

  it('resolves graded thinking levels and constrained sampling at route selection', () => {
    const route = resolveReasoningRoute({
      requestedProfile: 'claude-cli-default',
      thinkingLevel: 'high',
      constrainedSampling: {
        jsonSchema: { type: 'object' },
        strict: 'prefer',
      },
      env: {},
    });
    expect(route.thinkingLevel).toEqual({ requested: 'high', wireValue: 'high' });
    expect(route.constrainedSampling.mode).toBe('fallback');
  });

  it('rejects a required constrained feature or hidden thinking level before execution', () => {
    expect(() =>
      resolveReasoningRoute({
        requestedProfile: 'claude-cli-default',
        constrainedSampling: {
          jsonSchema: { type: 'object' },
          strict: 'require',
        },
        env: {},
      })
    ).toThrow(/No usable reasoning route/);
    expect(() =>
      resolveReasoningRoute({ requestedProfile: 'ollama-default', thinkingLevel: 'high', env: {} })
    ).toThrow(/No usable reasoning route/);
  });

  it('does not let a Grok CLI model override the Grok API route', () => {
    const route = resolveReasoningRoute({
      role: 'default',
      requestedProfile: 'grok-api-default',
      env: {
        XAI_API_KEY: 'xai-test-key',
        KYBERION_GROK_CLI_MODEL: 'grok-4.5-build',
      },
    });
    expect(route.mode).toBe('grok-api');
    expect(route.model).toBe('xai:grok-4.6');
  });

  it('accepts the registered Grok Build model alias for the CLI route', () => {
    const route = resolveReasoningRoute({
      role: 'default',
      requestedProfile: 'grok-cli-default',
      env: { KYBERION_GROK_CLI_MODEL: 'grok-4.5-build' },
    });
    expect(route.mode).toBe('grok-cli');
    expect(route.model).toBe('xai:grok-4.5-build');
  });

  it('rejects parameters unsupported by an adapter', () => {
    expect(() =>
      resolveSamplingParams({ mode: 'codex-cli', sampling: { temperature: 0.2 } })
    ).toThrow(/Unsupported parameters/);
  });

  it('rejects legacy sampling parameters for the current Gemini API route', () => {
    expect(() =>
      resolveSamplingParams({ mode: 'gemini-api', sampling: { temperature: 0.2 } })
    ).toThrow(/Unsupported parameters/);
  });

  it('does not silently pass through an unsafe translation policy', () => {
    const policy = {
      version: 'test',
      runtime_adapters: {
        test: { adapter: 'test', capabilities: ['text'], supported_parameters: [] },
      },
      profiles: { test: { mode: 'test' } },
      roles: { default: { candidates: ['test'] } },
      fallback: {
        max_attempts: 1,
        max_in_place_retries: 0,
        on_unsupported_parameter: 'translate' as const,
      },
    };
    expect(() =>
      resolveSamplingParams({ mode: 'test', sampling: { temperature: 0.2 }, policy })
    ).toThrow(/no safe translation/);
  });

  it('accepts dynamic policy roles and profile-prefixed bindings', () => {
    const policy = {
      version: 'test',
      runtime_adapters: {
        test: {
          adapter: 'test',
          model_policy: 'local-unregistered' as const,
          capabilities: ['text'],
          supported_parameters: [],
        },
      },
      profiles: { test: { mode: 'test', model: 'local-model' } },
      roles: { reviewer: { candidates: ['test'] } },
      fallback: {
        max_attempts: 1,
        max_in_place_retries: 0,
        on_unsupported_parameter: 'reject' as const,
      },
    };
    const route = resolveReasoningRoute({
      role: 'reviewer',
      requestedProfile: 'profile:test',
      env: {},
      policy,
    });
    expect(route.role).toBe('reviewer');
    expect(route.profileRef).toBe('test');
  });

  it('does not let an incapable first candidate hide the next valid candidate', () => {
    const route = resolveReasoningRoute({
      role: 'default',
      requiredCapabilities: ['structured_output'],
      env: {},
    });
    expect(route.profileRef).toBe('default-codex');
    expect(route.rejectedCandidates).toEqual([]);
  });

  it('uses the backend capability profile as the transport authority', () => {
    const route = resolveReasoningRoute({
      role: 'default',
      requestedProfile: 'ollama-default',
      env: {},
    });
    expect(route.capabilities).toContain('structured_output');
    expect(route.backendProfile?.transport).toBe('local-server');
    expect(route.provenance).toContainEqual({
      source: 'backend-profile',
      field: 'ollama.capabilities',
    });
  });

  it('rejects a built-in backend when a route requires a capability it declares absent', () => {
    expect(() =>
      resolveReasoningRoute({
        role: 'reviewer',
        requiredCapabilities: ['vision'],
        env: {},
        policy: {
          version: 'test',
          runtime_adapters: {
            ollama: {
              adapter: 'test',
              model_policy: 'local-unregistered',
              capabilities: ['text', 'vision'],
              supported_parameters: [],
            },
          },
          profiles: { local: { mode: 'ollama', capabilities: ['text', 'vision'] } },
          roles: { reviewer: { candidates: ['local'] } },
          fallback: {
            max_attempts: 1,
            max_in_place_retries: 0,
            on_unsupported_parameter: 'reject',
          },
        },
      })
    ).toThrow(/missing capabilities: vision/);
  });

  it('resolves step routing by tag and records the winning layer', () => {
    const policy = {
      version: 'test',
      runtime_adapters: {
        stub: {
          adapter: 'test',
          model_policy: 'local-unregistered' as const,
          capabilities: ['text'],
          supported_parameters: [],
        },
      },
      profiles: {
        cheap: { mode: 'stub', model: 'cheap' },
        deep: { mode: 'stub', model: 'deep' },
      },
      roles: { default: { candidates: ['cheap'] } },
      routing: { tags: { judge: { profile: 'deep', permission_mode: 'readonly' as const } } },
      permission_floor: 'readonly' as const,
      fallback: {
        max_attempts: 1,
        max_in_place_retries: 0,
        on_unsupported_parameter: 'reject' as const,
      },
    };
    const route = resolveStepReasoningRoute({
      stepId: 'classify',
      tags: ['judge'],
      policy,
      env: {},
    });
    expect(route.profile).toBe('deep');
    expect(route.source).toBe('routing.tag');
    expect(route.provenance).toContain('routing.tags.judge');
  });

  it('promotes only after the declared failure threshold and enforces the permission floor', () => {
    const policy = {
      version: 'test',
      runtime_adapters: {
        stub: {
          adapter: 'test',
          model_policy: 'local-unregistered' as const,
          capabilities: ['text'],
          supported_parameters: [],
        },
      },
      profiles: { base: { mode: 'stub' }, promoted: { mode: 'stub', model: 'promoted' } },
      roles: { default: { candidates: ['base'] } },
      permission_floor: 'edit' as const,
      fallback: {
        max_attempts: 1,
        max_in_place_retries: 0,
        on_unsupported_parameter: 'reject' as const,
      },
    };
    const step = {
      permission_mode: 'edit' as const,
      promotion: [{ after_failures: 2, profile: 'promoted', permission_mode: 'edit' as const }],
    };
    expect(
      resolveStepReasoningRoute({ stepId: 'x', step, failures: 1, policy, env: {} }).profile
    ).toBe('base');
    expect(
      resolveStepReasoningRoute({ stepId: 'x', step, failures: 2, policy, env: {} }).profile
    ).toBe('promoted');
    expect(() =>
      resolveStepReasoningRoute({
        stepId: 'x',
        step: { profile: 'base', permission_mode: 'readonly' },
        policy,
        env: {},
      })
    ).toThrow(/PERMISSION_FLOOR/);
  });
});
