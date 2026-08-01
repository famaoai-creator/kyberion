import { describe, expect, it } from 'vitest';
import {
  BACKEND_CAPABILITY_PROFILES,
  backendCapabilityProfile,
  modesWithUtilityFit,
} from './backend-capability-profile.js';
import {
  buildFailoverReasoningBackend,
  stubReasoningBackend,
  type ReasoningBackend,
} from './reasoning-backend.js';

describe('backend capability profiles (QM-06)', () => {
  it('every profile is self-consistent (mode key matches declaration)', () => {
    for (const [mode, profile] of Object.entries(BACKEND_CAPABILITY_PROFILES)) {
      expect(profile.mode).toBe(mode);
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
