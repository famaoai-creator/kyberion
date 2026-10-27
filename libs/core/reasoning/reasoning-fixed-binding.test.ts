import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ReasoningRouteUserConfig,
  ResolveReasoningRouteInput,
} from './reasoning-route-resolver.js';

const state = vi.hoisted(() => ({
  config: {} as ReasoningRouteUserConfig,
  pin: null as { provider: string; modelId: string } | null,
}));
vi.mock('./reasoning-route-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reasoning-route-resolver.js')>();
  return {
    ...actual,
    loadReasoningRouteUserConfig: () => state.config,
    resolveReasoningRoute: (input: ResolveReasoningRouteInput = {}) =>
      actual.resolveReasoningRoute({
        ...input,
        env: {},
        brokerPin: state.pin,
        userConfig: state.config,
        readiness: { anthropic: { available: true, reason: 'fixture ready' } },
      }),
  };
});
vi.mock('./reasoning-egress-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./reasoning-egress-scope.js')>()),
  assertReasoningEgressAllowed: vi.fn(),
}));
vi.mock('../metrics.js', () => ({ metrics: { record: vi.fn() } }));

import { resolveReasoningRoute } from './reasoning-route-resolver.js';
import { installReasoningBackends, resetReasoningBootstrap } from './reasoning-bootstrap.js';
import { buildApiProviderBundle } from './reasoning-api-provider.js';
import {
  bindFixedReasoningBackend,
  bindReasoningRequestTimeout,
  reasoningSelectionWireModel,
} from './reasoning-fixed-binding.js';
import {
  buildFailoverReasoningBackend,
  buildRoleAwareReasoningBackend,
  getReasoningBackend,
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
} from './reasoning-backend.js';

describe('fixed reasoning runtime dispatch', () => {
  beforeEach(() => {
    state.pin = null;
    state.config = {
      roles: {
        default: {
          selection: {
            mode: 'fixed',
            runtime_mode: 'anthropic',
            profile: 'anthropic-default',
            model: 'anthropic:claude-opus-4-8',
          },
        },
      },
    };
  });
  afterEach(() => {
    state.config = {};
    resetReasoningBackend();
    resetReasoningBootstrap();
    vi.clearAllMocks();
  });

  function runtime(
    create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'fixture result' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  ) {
    const route = resolveReasoningRoute({ role: 'default' });
    const bundle = buildApiProviderBundle({
      mode: 'anthropic',
      model: reasoningSelectionWireModel(route.model),
      env: {},
      anthropicClient: { messages: { create } } as unknown as Anthropic,
    })!;
    const fixed = bindFixedReasoningBackend(
      buildFailoverReasoningBackend([bundle.backend], route.failover),
      route
    );
    const fallback = { ...bundle.backend.backend, name: 'unrelated-profile' };
    return {
      create,
      backend: buildRoleAwareReasoningBackend(
        fixed,
        new Map([['default', fixed]]),
        new Map([['other', fallback]])
      ),
    };
  }

  it('keeps inherited auxiliary calls on the fixed default and blocks profile escapes', async () => {
    const { backend, create } = runtime();
    for (const role of ['context_compaction', 'background_review']) {
      await expect(backend.prompt('fixture prompt', { role })).resolves.toBe('fixture result');
      expect(() => backend.prompt('fixture prompt', { role, route_profile: 'other' })).toThrow(
        /SELECTION_CONFLICT/
      );
    }
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ model: 'claude-opus-4-8' });
  });

  it('rejects an auxiliary result synchronously resolved by the abort listener', async () => {
    vi.useFakeTimers();
    const backend = bindReasoningRequestTimeout(
      {
        ...stubReasoningBackend,
        prompt: async (_prompt, options) =>
          new Promise<string>((resolve) => {
            options?.signal?.addEventListener('abort', () => resolve('stale summary'));
          }),
      },
      1234
    );
    try {
      const result = backend.prompt('compact');
      const rejected = expect(result).rejects.toThrow('REASONING_REQUEST_TIMEOUT');
      await vi.advanceTimersByTimeAsync(1234);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds one auxiliary request, forwards cancellation, and discards late results', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let complete: (value: string) => void = () => {};
    const pending = new Promise<string>((resolve) => {
      complete = resolve;
    });
    const backend = bindReasoningRequestTimeout(
      {
        ...stubReasoningBackend,
        prompt: async (_prompt, options) => {
          signal = options?.signal;
          return pending;
        },
      },
      1234
    );
    try {
      const result = backend.prompt('compact', { role: 'context_compaction' });
      const rejected = expect(result).rejects.toThrow('REASONING_REQUEST_TIMEOUT');
      await vi.advanceTimersByTimeAsync(1234);
      await rejected;
      expect(signal?.aborted).toBe(true);
      complete('late summary');
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers the fixed exact model to the actual Anthropic adapter request through role dispatch', async () => {
    const { backend, create } = runtime();
    await expect(backend.prompt('fixture prompt', { role: 'default' })).resolves.toBe(
      'fixture result'
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ model: 'claude-opus-4-8' });
  });
  it('blocks per-call model and tier overrides before reaching the adapter', () => {
    const { backend, create } = runtime();
    expect(() =>
      backend.prompt('fixture prompt', { role: 'default', model: 'claude-opus-5-5' })
    ).toThrow(/SELECTION_CONFLICT/);
    expect(() => backend.prompt('fixture prompt', { role: 'default', model_tier: 'fast' })).toThrow(
      /SELECTION_CONFLICT/
    );
    expect(create).not.toHaveBeenCalled();
  });
  it('blocks the profile dispatcher escape path', () => {
    const { backend, create } = runtime();
    expect(() =>
      backend.prompt('fixture prompt', { role: 'default', route_profile: 'other' })
    ).toThrow(/SELECTION_CONFLICT/);
    expect(create).not.toHaveBeenCalled();
  });
  it('does not fall back to another runtime after the fixed provider rejects a request', async () => {
    const create = vi.fn().mockRejectedValue(new Error('fixture unavailable'));
    const { backend } = runtime(create);
    await expect(backend.prompt('fixture prompt')).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('fails closed when settings changed but the old runtime is still installed', () => {
    const { backend, create } = runtime();
    state.config.roles!.default!.selection!.model = 'anthropic:claude-opus-5-5';
    expect(() => backend.prompt('fixture prompt')).toThrow(/active backend conflicts/);
    expect(create).not.toHaveBeenCalled();
  });
  it('keeps unregistered local model tags intact on the runtime wire', () => {
    expect(reasoningSelectionWireModel('llama:8b')).toBe('llama:8b');
    expect(reasoningSelectionWireModel('anthropic:claude-opus-4-8')).toBe('claude-opus-4-8');
  });
  it('prevents cached stub and custom backend reuse from bypassing a new fixed setting', () => {
    resetReasoningBackend();
    expect(() => getReasoningBackend().prompt('fixture prompt')).toThrow(
      /reselect reasoning backends/
    );
    registerReasoningBackend({ ...stubReasoningBackend, name: 'custom-fixture' });
    expect(() => getReasoningBackend().prompt('fixture prompt')).toThrow(
      /reselect reasoning backends/
    );
  });
  it('preflights a non-default fixed role before an explicit stub bootstrap can return', () => {
    state.config.roles = { subagent: state.config.roles!.default! };
    resetReasoningBootstrap();
    expect(() => installReasoningBackends({ mode: 'stub' })).toThrow(/SELECTION_CONFLICT/);
  });

  it('enforces a stronger broker model pin on an otherwise runtime-only fixed setting', async () => {
    delete state.config.roles!.default!.selection!.model;
    state.pin = { provider: 'anthropic', modelId: 'claude-opus-4-8' };
    const { backend, create } = runtime();
    await backend.prompt('fixture prompt');
    expect(create.mock.calls[0]?.[0]).toMatchObject({ model: 'claude-opus-4-8' });
    expect(() => backend.prompt('fixture prompt', { model_tier: 'fast' })).toThrow(
      /broker-pinned model/
    );
    expect(() => backend.prompt('fixture prompt', { model: 'claude-opus-5-5' })).toThrow(
      /SELECTION_CONFLICT/
    );
    expect(create).toHaveBeenCalledTimes(1);
  });
});
