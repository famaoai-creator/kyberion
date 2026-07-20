import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveReasoningRoute,
  resolveSamplingParams,
  normalizeReasoningRole,
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

  it('rejects parameters unsupported by an adapter', () => {
    expect(() =>
      resolveSamplingParams({ mode: 'codex-cli', sampling: { temperature: 0.2 } })
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
});
