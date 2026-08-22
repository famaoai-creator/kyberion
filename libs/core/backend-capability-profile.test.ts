import { describe, expect, it } from 'vitest';
import {
  BACKEND_CAPABILITY_PROFILES,
  availableThinkingLevels,
  backendCapabilityProfile,
  backendRouteCapabilities,
  modesWithUtilityFit,
  resolveConstrainedSampling,
  resolveThinkingLevel,
} from './backend-capability-profile.js';
import { loadReasoningRoutePolicy } from './reasoning-route-resolver.js';
import { listReasoningProviderDescriptors } from './reasoning-provider-registry.js';
import {
  buildFailoverReasoningBackend,
  stubReasoningBackend,
  type ReasoningBackend,
} from './reasoning-backend.js';

describe('backend capability profiles (QM-06)', () => {
  it('every profile is self-consistent (mode key matches declaration)', () => {
    for (const [mode, profile] of Object.entries(BACKEND_CAPABILITY_PROFILES)) {
      expect(profile.mode).toBe(mode);
      expect(['local-only', 'external-api']).toContain(profile.data_egress);
    }
  });

  it('separates local adapter execution from the data egress boundary', () => {
    expect(backendCapabilityProfile('agy-cli')).toMatchObject({
      transport: 'cli',
      data_egress: 'external-api',
    });
    expect(backendCapabilityProfile('ollama')).toMatchObject({
      transport: 'local-server',
      data_egress: 'local-only',
    });
  });

  it('declares the expanded execution capability dimensions', () => {
    expect(backendCapabilityProfile('gemini-api').capabilities).toMatchObject({
      streaming: true,
      tool_calling: true,
    });
    expect(backendCapabilityProfile('claude-agent').capabilities).toMatchObject({
      input_modalities: ['text', 'image'],
      native_subagent: true,
    });
    expect(backendRouteCapabilities(backendCapabilityProfile('ollama'))).toEqual([
      'text',
      'structured_output',
      'tools',
      'streaming',
    ]);
  });

  it('keeps route policy declarations within canonical backend capabilities', () => {
    const policy = loadReasoningRoutePolicy();
    const declarations = [
      ...Object.entries(policy.runtime_adapters).map(
        ([mode, adapter]) => [mode, adapter.capabilities] as const
      ),
      ...Object.entries(policy.profiles).map(
        ([profileRef, profile]) =>
          [`${profileRef} (${profile.mode})`, profile.capabilities ?? [], profile.mode] as const
      ),
    ];

    for (const [label, requested, explicitMode] of declarations) {
      const mode = explicitMode ?? label;
      if (!Object.prototype.hasOwnProperty.call(BACKEND_CAPABILITY_PROFILES, mode)) continue;
      const supported = backendRouteCapabilities(
        backendCapabilityProfile(mode as keyof typeof BACKEND_CAPABILITY_PROFILES)
      );
      for (const capability of requested) {
        expect(
          supported,
          `${label} requests ${capability}, but ${mode} does not declare it`
        ).toContain(capability);
      }
    }
  });

  it('keeps overlapping provider registry fields synchronized', () => {
    for (const descriptor of listReasoningProviderDescriptors()) {
      const profile = backendCapabilityProfile(descriptor.mode);
      expect(descriptor.capabilities.structured_output, descriptor.mode).toBe(
        profile.capabilities.structured_output
      );
      expect(descriptor.capabilities.abort, descriptor.mode).toBe(profile.capabilities.abort);
      expect(descriptor.capabilities.session_continuity, descriptor.mode).toBe(
        profile.capabilities.session_continuity
      );
      expect(descriptor.capabilities.input_modalities, descriptor.mode).toEqual(
        profile.capabilities.input_modalities
      );
    }
  });

  it('the stub declares no utility fit — wisdom ops must not route to it', () => {
    const stub = backendCapabilityProfile('stub');
    expect(stub.utility_fit).toEqual([]);
    expect(modesWithUtilityFit('divergent')).not.toContain('stub');
  });

  it('divergent utility fit is only declared by full-capability backends', () => {
    for (const mode of modesWithUtilityFit('divergent')) {
      const profile = backendCapabilityProfile(mode);
      expect(profile.capabilities.structured_output, `${mode} must support structured output`).toBe(
        true
      );
    }
  });

  it('local-server transports never claim session continuity', () => {
    for (const profile of Object.values(BACKEND_CAPABILITY_PROFILES)) {
      if (profile.transport === 'local-server') {
        expect(
          profile.capabilities.session_continuity,
          `${profile.mode} is stateless local serving`
        ).toBe(false);
      }
    }
  });

  it('declares provider retry separately from orchestration retry', () => {
    for (const profile of Object.values(BACKEND_CAPABILITY_PROFILES)) {
      expect(profile.provider_retry.max_retries, profile.mode).toBe(0);
      expect(profile.provider_retry.quota_errors_propagate, profile.mode).toBe(true);
    }
  });

  it('exposes graded thinking levels and hides provider-default-only backends', () => {
    const cliProfile = backendCapabilityProfile('claude-cli');
    expect(availableThinkingLevels(cliProfile)).toEqual(['low', 'medium', 'high']);
    expect(resolveThinkingLevel(cliProfile, 'high')).toMatchObject({
      supported: true,
      wireValue: 'high',
    });

    const localProfile = backendCapabilityProfile('ollama');
    expect(availableThinkingLevels(localProfile)).toEqual([]);
    expect(resolveThinkingLevel(localProfile, 'high')).toMatchObject({
      supported: false,
      reason: 'provider-default-only',
    });
  });

  it('fails closed for required constrained sampling and degrades preferred requests', () => {
    const request = { jsonSchema: { type: 'object' }, strict: 'require' as const };
    expect(() =>
      resolveConstrainedSampling(request, {
        supportsStrictTools: false,
        supportsGrammarTools: false,
      })
    ).toThrow(/required but not supported/);
    expect(
      resolveConstrainedSampling(
        { ...request, strict: 'prefer' },
        { supportsStrictTools: false, supportsGrammarTools: false }
      )
    ).toMatchObject({ mode: 'fallback' });
    expect(
      resolveConstrainedSampling(request, {
        supportsStrictTools: true,
        supportsGrammarTools: false,
      })
    ).toMatchObject({ mode: 'native' });
  });
});

describe('failover reset-on-switch (QM-06)', () => {
  function makeCandidates() {
    const events: string[] = [];
    let primaryHealthy = false;
    const primary: ReasoningBackend = {
      ...stubReasoningBackend,
      name: 'stub',
      delegateTask: async () => {
        if (!primaryHealthy) throw new Error('primary down');
        events.push('serve:primary');
        return 'from-primary';
      },
      resetSession: () => {
        events.push('reset:primary');
      },
    };
    const secondary: ReasoningBackend = {
      ...stubReasoningBackend,
      name: 'stub',
      delegateTask: async () => {
        events.push('serve:secondary');
        return 'from-secondary';
      },
      resetSession: () => {
        events.push('reset:secondary');
      },
    };
    const backend = buildFailoverReasoningBackend([
      { label: 'qm06-primary', provider: 'qm06-test-a', backend: primary },
      { label: 'qm06-secondary', provider: 'qm06-test-b', backend: secondary },
    ]);
    return { backend, events, setPrimaryHealthy: (v: boolean) => (primaryHealthy = v) };
  }

  it('resets both sides when the serving candidate changes, and never on a stable route', async () => {
    const { backend, events, setPrimaryHealthy } = makeCandidates();

    setPrimaryHealthy(true);
    await backend.delegateTask('t1');
    expect(events).toEqual(['serve:primary']);

    await backend.delegateTask('t2');
    expect(events).toEqual(['serve:primary', 'serve:primary']);

    setPrimaryHealthy(false);
    await backend.delegateTask('t3');
    expect(events).toContain('serve:secondary');
    // Review finding 4: the INCOMING backend must be reset BEFORE it serves
    // the post-switch call; the outgoing backend is reset after.
    expect(events.indexOf('reset:secondary')).toBeLessThan(events.indexOf('serve:secondary'));
    expect(events.indexOf('reset:primary')).toBeGreaterThan(events.indexOf('serve:secondary'));
    expect(events.filter((event) => event === 'reset:secondary')).toHaveLength(1);

    // Route now stable on the secondary — the serving backend is never reset
    // again (the failing primary may see best-effort incoming resets).
    const countBefore = events.length;
    await backend.delegateTask('t4');
    const newEvents = events.slice(countBefore);
    expect(newEvents).toContain('serve:secondary');
    expect(newEvents.filter((event) => event === 'reset:secondary')).toHaveLength(0);
  });
});
