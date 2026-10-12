import { describe, expect, it } from 'vitest';
import {
  resolveReasoningRoute,
  resolveReasoningRouteCandidates,
  type ReasoningRoleSelection,
  type ReasoningRoutePolicy,
  type ResolveReasoningRouteInput,
} from './reasoning-route-resolver.js';
import { loadReasoningBackendPolicy } from './reasoning-backend-policy.js';

const policy: ReasoningRoutePolicy = {
  version: 'test',
  runtime_adapters: {
    anthropic: {
      adapter: 'anthropic-sdk',
      selection: {
        display_name: 'Anthropic',
        model_provider: 'anthropic',
        availability: { kind: 'env_any', names: ['ANTHROPIC_API_KEY'] },
      },
      capabilities: ['text', 'vision'],
      supported_parameters: [],
    },
    'codex-cli': {
      adapter: 'codex-cli',
      selection: {
        display_name: 'Codex',
        model_provider: 'openai',
        discovery_provider: 'codex',
        availability: { kind: 'provider_discovery' },
      },
      capabilities: ['text'],
      supported_parameters: [],
    },
    ollama: {
      adapter: 'openai-compatible',
      model_policy: 'local-unregistered',
      capabilities: ['text'],
      supported_parameters: [],
    },
  },
  profiles: {
    claude: { mode: 'anthropic', model_ref: 'anthropic:claude-opus-5-5' },
    codex: { mode: 'codex-cli', model_ref: 'openai:gpt-6-sol' },
    local: { mode: 'ollama', model: 'llama:8b' },
  },
  roles: { reviewer: { candidates: ['claude', 'codex'], requires: ['text'] } },
  fallback: { max_attempts: 3, max_in_place_retries: 1, on_unsupported_parameter: 'reject' },
};
function input(selection?: ReasoningRoleSelection): ResolveReasoningRouteInput {
  return {
    role: 'reviewer',
    policy,
    env: {},
    brokerPin: null,
    userConfig: selection ? { roles: { reviewer: { selection } } } : {},
    readiness: {
      anthropic: { available: true, reason: 'fixture ready' },
      'codex-cli': { available: true, reason: 'fixture ready' },
      ollama: { available: true, reason: 'fixture ready' },
    },
  };
}
const fixed: ReasoningRoleSelection = {
  mode: 'fixed',
  runtime_mode: 'anthropic',
  provider: 'anthropic',
  model: 'anthropic:claude-opus-4-8',
};

describe('reasoning role selections', () => {
  it('preserves absent-setting legacy routes, without inventing fixed semantics', () => {
    const route = resolveReasoningRoute(input());
    expect(route.profileRef).toBe('claude');
    expect(route.selection).toBeUndefined();
    expect(route.candidates).toEqual(['claude', 'codex']);
  });
  it('fixes the exact requested model with one execution candidate', () => {
    const routes = resolveReasoningRouteCandidates(input(fixed));
    expect(routes).toHaveLength(1);
    expect(routes[0]?.model).toBe('anthropic:claude-opus-4-8');
    expect(routes[0]?.selection?.source).toBe('user');
    expect(routes[0]?.failover.max_attempts).toBe(1);
    expect(routes[0]?.failover.max_in_place_retries).toBe(0);
  });
  it('supports fixed runtime with explicitly automatic model', () => {
    const route = resolveReasoningRoute(input({ mode: 'fixed', runtime_mode: 'anthropic' }));
    expect(route.model).toBe('anthropic:claude-opus-5-5');
    expect(route.selection?.reason).toContain('model follows normal model resolution');
  });
  it('puts an eligible preference ahead of policy order and exposes fallback', () => {
    const preferred = {
      mode: 'preferred' as const,
      runtime_mode: 'codex-cli',
      model: 'openai:gpt-6-sol',
    };
    expect(resolveReasoningRoute(input(preferred)).mode).toBe('codex-cli');
    const context = input(preferred);
    context.readiness!['codex-cli'] = { available: false, reason: 'cached unavailable' };
    const route = resolveReasoningRoute(context);
    expect(route.mode).toBe('anthropic');
    expect(route.selection?.fallback).toBe(true);
    expect(route.rejectedCandidates).toContainEqual({
      profile: 'codex',
      reason: 'cached unavailable',
    });
  });
  it('keeps request and environment precedence explicit for preferred mode', () => {
    const context = input({ mode: 'preferred', runtime_mode: 'anthropic' });
    const requested = resolveReasoningRoute({ ...context, requestedMode: 'codex-cli' });
    expect(requested.mode).toBe('codex-cli');
    expect(requested.selection?.source).toBe('request');
    const env = resolveReasoningRoute({
      ...context,
      env: { KYBERION_REASONING_BACKEND: 'codex-cli' },
    });
    expect(env.mode).toBe('codex-cli');
    expect(env.selection?.source).toBe('env');
  });
  it.each([
    { requestedMode: 'codex-cli' },
    { requestedModel: 'anthropic:claude-opus-5-5' },
    { requestedProfile: 'codex' },
    { env: { KYBERION_REASONING_BACKEND: 'codex-cli' } },
    { env: { KYBERION_REASONING_ROLE_REVIEWER: 'codex' } },
    { env: { KYBERION_ANTHROPIC_MODEL: 'claude-opus-5-5' } },
    { env: { KYBERION_REASONING_MODEL: 'claude-opus-5-5' } },
  ])('rejects conflicting fixed request/environment constraints: %j', (override) => {
    expect(() => resolveReasoningRoute({ ...input(fixed), ...override })).toThrow(
      /SELECTION_CONFLICT/
    );
  });
  it('accepts a matching unprefixed environment model without changing the target', () => {
    expect(
      resolveReasoningRoute({
        ...input(fixed),
        env: { KYBERION_ANTHROPIC_MODEL: 'claude-opus-4-8' },
      }).model
    ).toBe(fixed.model);
  });
  it('fails closed for unknown models, provider mismatch, missing capabilities, and cached unavailability', () => {
    for (const selection of [
      { ...fixed, model: 'not-approved' },
      { ...fixed, model: 'openai:gpt-6-sol' },
      { ...fixed, provider: 'codex' },
    ]) {
      expect(() => resolveReasoningRoute(input(selection))).toThrow(/SELECTION_UNAVAILABLE/);
    }
    expect(() =>
      resolveReasoningRoute({
        ...input({ mode: 'fixed', runtime_mode: 'codex-cli' }),
        requiredCapabilities: ['vision'],
      })
    ).toThrow(/SELECTION_UNAVAILABLE/);
    const unavailable = input(fixed);
    unavailable.readiness!.anthropic = { available: false, reason: 'cached unavailable' };
    expect(() => resolveReasoningRouteCandidates(unavailable)).toThrow(/SELECTION_UNAVAILABLE/);
  });
  it('applies scoped allowed_modes to fixed and preferred candidates', () => {
    const backendPolicy = {
      ...loadReasoningBackendPolicy(),
      allowed_modes: ['codex-cli' as const],
    };
    expect(() => resolveReasoningRoute({ ...input(fixed), backendPolicy })).toThrow(
      /SELECTION_UNAVAILABLE/
    );
    const route = resolveReasoningRoute({
      ...input({ ...fixed, mode: 'preferred' }),
      backendPolicy,
    });
    expect(route.mode).toBe('codex-cli');
    expect(route.selection?.fallback).toBe(true);
  });
  it('explains unsupported fixed dispatcher execution before saving', () => {
    for (const key of ['KYBERION_HARNESS_SUBAGENT', 'KYBERION_IN_SESSION_SUBAGENT']) {
      expect(() => resolveReasoningRoute({ ...input(fixed), env: { [key]: '1' } })).toThrow(
        /unsupported while independent subagent dispatch/
      );
    }
  });
  it('retains local model tags exactly rather than treating them as registry prefixes', () => {
    const route = resolveReasoningRoute(
      input({ mode: 'fixed', runtime_mode: 'ollama', model: 'llama:8b' })
    );
    expect(route.model).toBe('llama:8b');
  });
  it('automatic mode filters unavailable candidates without creating fixed semantics', () => {
    const context = input({ mode: 'auto' });
    context.readiness!.anthropic = { available: false, reason: 'unavailable' };
    const route = resolveReasoningRoute(context);
    expect(route.mode).toBe('codex-cli');
    expect(route.selection?.reasonCode).toBe('automatic');
  });
  it('rejects conflicting cached broker provider and exact-model pins', () => {
    expect(() =>
      resolveReasoningRoute({
        ...input(fixed),
        brokerPin: { provider: 'codex', modelId: 'openai:gpt-6-sol' },
      })
    ).toThrow(/broker provider pin conflicts/);
    expect(() =>
      resolveReasoningRoute({
        ...input(fixed),
        brokerPin: { provider: 'anthropic', modelId: 'claude-opus-5-5' },
      })
    ).toThrow(/broker model pin conflicts/);
    expect(
      resolveReasoningRoute({
        ...input(fixed),
        brokerPin: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
      }).model
    ).toBe('anthropic:claude-opus-4-8');
  });

  it('distinguishes runtime-only fixed from a stronger exact broker model pin', () => {
    const context = {
      ...input({ mode: 'fixed' as const, runtime_mode: 'anthropic' }),
      brokerPin: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
    };
    const route = resolveReasoningRoute(context);
    expect(route.selection?.requested.model).toBeUndefined();
    expect(route.selection?.modelPinned).toBe(true);
    expect(route.selection?.reason).toContain('capability broker policy');
    expect(route.model).toBe('anthropic:claude-opus-4-8');
    expect(() => resolveReasoningRoute({ ...context, requestedModel: 'claude-opus-5-5' })).toThrow(
      /SELECTION_CONFLICT/
    );
    expect(() =>
      resolveReasoningRoute({ ...context, env: { KYBERION_ANTHROPIC_MODEL: 'claude-opus-5-5' } })
    ).toThrow(/SELECTION_CONFLICT/);
  });
});
