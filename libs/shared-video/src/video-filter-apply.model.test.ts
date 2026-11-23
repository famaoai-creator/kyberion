import { afterEach, describe, expect, it, vi } from 'vitest';
const external = vi.hoisted(() => vi.fn());
vi.mock('@agent/core/governance/external-operation', () => ({ runExternalOperation: external }));
import {
  checkFiniteStateSafety,
  type ModelStep,
  type SafetyModel,
} from '../../core/testing/finite-state-checker.js';
import {
  applyVideoFilter,
  registerVideoFilterProvider,
  resetVideoFilterProviders,
  type VideoFilterProvider,
  type VideoFilterRequest,
} from './video-filter.js';

// Safety properties under verification (executable safety model; see
// knowledge/product/architecture/executable-safety-models.md):
//   applyVideoFilter runs a governed dispatch pipeline:
//   validate → select provider → capability check → probe → prepare →
//   approved external operation → commit → verify echo → result.
//   The model asserts: each stage requires the previous gate to pass;
//   a failing gate is terminal for the call; at most one provider is ever
//   contacted (probe/unavailable/commit failures never redispatch);
//   commit runs only inside the approved external operation; and a
//   successful result requires the provider's echo to match the request.
//
// Abstraction: the request is already contract-valid or not; providers are
// counted, not identified beyond existence; approval collapses to
// grant/deny; commit results collapse to echo/mismatch/throw. Real digest
// derivation, approval UX, audit chains, and provider internals are
// outside the model.

type ApplyPhase =
  'idle' | 'validated' | 'selected' | 'capable' | 'probed' | 'prepared' | 'op' | 'done' | 'failed';

interface ApplyConfig {
  /** Registered provider count. */
  providers: 1 | 2;
  /** Caller preference. */
  preference: 'auto' | 'software' | 'ghost';
  /** Selected provider declares the request type. */
  capable: boolean;
}

interface ApplyState {
  phase: ApplyPhase;
  probes: number;
  prepares: number;
  ops: number;
  commits: number;
  result: 'none' | 'echo' | 'mismatch';
}

const applyIdle: ApplyState = {
  phase: 'idle',
  probes: 0,
  prepares: 0,
  ops: 0,
  commits: 0,
  result: 'none',
};

function applyNext(cfg: ApplyConfig) {
  return (s: ApplyState): ModelStep<ApplyState>[] => {
    if (s.phase === 'done' || s.phase === 'failed') return [];
    const out: ModelStep<ApplyState>[] = [];
    switch (s.phase) {
      case 'idle':
        // Contract validation precedes everything; invalid input fails
        // before any provider or approval machinery is touched.
        out.push({ action: 'validate:ok', state: { ...s, phase: 'validated' } });
        out.push({ action: 'validate:invalid', state: { ...s, phase: 'failed' } });
        break;
      case 'validated': {
        const resolved =
          cfg.preference === 'auto' ? cfg.providers === 1 : cfg.preference === 'software';
        out.push({
          action: resolved ? 'resolve:selected' : 'resolve:failed',
          state: { ...s, phase: resolved ? 'selected' : 'failed' },
        });
        break;
      }
      case 'selected':
        out.push({
          action: cfg.capable ? 'capability:ok' : 'capability:unsupported',
          state: { ...s, phase: cfg.capable ? 'capable' : 'failed' },
        });
        break;
      case 'capable':
        out.push({
          action: 'probe:ok',
          state: { ...s, phase: 'probed', probes: s.probes + 1 },
        });
        out.push({
          action: 'probe:unavailable',
          state: { ...s, phase: 'failed', probes: s.probes + 1 },
        });
        out.push({
          action: 'probe:throws',
          state: { ...s, phase: 'failed', probes: s.probes + 1 },
        });
        break;
      case 'probed':
        out.push({
          action: 'prepare:ok',
          state: { ...s, phase: 'prepared', prepares: s.prepares + 1 },
        });
        out.push({
          action: 'prepare:bad-target',
          state: { ...s, phase: 'failed', prepares: s.prepares + 1 },
        });
        out.push({
          action: 'prepare:throws',
          state: { ...s, phase: 'failed', prepares: s.prepares + 1 },
        });
        break;
      case 'prepared':
        out.push({
          action: 'op:grant',
          state: { ...s, phase: 'op', ops: s.ops + 1 },
        });
        out.push({
          action: 'op:deny',
          state: { ...s, phase: 'failed', ops: s.ops + 1 },
        });
        break;
      case 'op':
        out.push({
          action: 'commit:echo',
          state: { ...s, phase: 'done', commits: s.commits + 1, result: 'echo' },
        });
        out.push({
          action: 'commit:mismatch',
          state: { ...s, phase: 'failed', commits: s.commits + 1, result: 'mismatch' },
        });
        out.push({
          action: 'commit:throws',
          state: { ...s, phase: 'failed', commits: s.commits + 1 },
        });
        break;
    }
    return out;
  };
}

function applyInvariants(): SafetyModel<ApplyState>['invariants'] {
  return {
    'a probe runs only after a capability pass': (s) => s.probes === 0 || s.phase !== 'selected',
    'at most one provider is probed': (s) => s.probes <= 1,
    'prepare requires a successful probe': (s) => s.prepares === 0 || s.probes > 0,
    'at most one provider prepares': (s) => s.prepares <= 1,
    'the external op requires a bound target': (s) => s.ops === 0 || s.prepares > 0,
    'at most one external op': (s) => s.ops <= 1,
    'commit only inside the approved operation': (s) => s.commits === 0 || s.ops > 0,
    'at most one commit': (s) => s.commits <= 1,
    'success requires an echo result': (s) => s.phase !== 'done' || s.result === 'echo',
    // A counted side effect implies the pipeline reached its stage — a
    // phase may only regress to 'failed', never back to an earlier stage.
    'a probe count implies the probe stage or beyond': (s) =>
      s.probes === 0 ||
      s.phase === 'probed' ||
      s.phase === 'prepared' ||
      s.phase === 'op' ||
      s.phase === 'done' ||
      s.phase === 'failed',
    'a prepare count implies the prepare stage or beyond': (s) =>
      s.prepares === 0 ||
      s.phase === 'prepared' ||
      s.phase === 'op' ||
      s.phase === 'done' ||
      s.phase === 'failed',
    'an op count implies the op stage or beyond': (s) =>
      s.ops === 0 || s.phase === 'op' || s.phase === 'done' || s.phase === 'failed',
  };
}

function applyModel(cfg: ApplyConfig): SafetyModel<ApplyState> {
  return {
    initial: [applyIdle],
    key: (s) => JSON.stringify(s),
    next: applyNext(cfg),
    invariants: applyInvariants(),
  };
}

describe('applyVideoFilter finite-state specification', () => {
  const configs: Array<{ name: string; cfg: ApplyConfig; visited: number; transitions: number }> = [
    {
      name: 'auto single capable',
      cfg: { providers: 1, preference: 'auto', capable: true },
      visited: 14,
      transitions: 15,
    },
    {
      name: 'explicit capable',
      cfg: { providers: 2, preference: 'software', capable: true },
      visited: 14,
      transitions: 15,
    },
    {
      name: 'auto ambiguous',
      cfg: { providers: 2, preference: 'auto', capable: true },
      visited: 3,
      transitions: 3,
    },
    {
      name: 'unknown provider',
      cfg: { providers: 1, preference: 'ghost', capable: true },
      visited: 3,
      transitions: 3,
    },
    {
      name: 'unsupported capability',
      cfg: { providers: 1, preference: 'software', capable: false },
      visited: 4,
      transitions: 4,
    },
  ];
  for (const { name, cfg, visited, transitions } of configs) {
    it(`exhausts ${name} without a safety violation`, () => {
      const result = checkFiniteStateSafety(applyModel(cfg));
      expect(result).toEqual({ status: 'verified', visited, transitions });
    });
  }

  it('detects a redispatch-to-second-provider mutation', () => {
    const cfg: ApplyConfig = { providers: 2, preference: 'software', capable: true };
    const next = applyNext(cfg);
    const result = checkFiniteStateSafety({
      ...applyModel(cfg),
      next: (s) => {
        const out = next(s).map((step) =>
          // Mutant: a failed probe falls back to the other provider.
          step.action === 'probe:unavailable' || step.action === 'probe:throws'
            ? { ...step, state: { ...step.state, phase: 'capable' as const } }
            : step
        );
        return out;
      },
    });
    expect(result.status).toBe('violated');
    // The redispatch lands back on 'capable' with a probe already counted —
    // the stage-regression invariant fires before the second probe runs.
    expect(result.invariant).toBe('a probe count implies the probe stage or beyond');
  });

  it('detects an unapproved commit mutation', () => {
    const cfg: ApplyConfig = { providers: 1, preference: 'auto', capable: true };
    const next = applyNext(cfg);
    const result = checkFiniteStateSafety({
      ...applyModel(cfg),
      next: (s) => {
        const out = next(s);
        // Mutant: commit straight after prepare, outside the external op.
        if (s.phase === 'prepared') {
          out.push({
            action: 'mutant:commit-unapproved',
            state: { ...s, phase: 'done', commits: s.commits + 1, result: 'echo' },
          });
        }
        return out;
      },
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('commit only inside the approved operation');
  });

  it('detects a prepare-before-probe mutation', () => {
    const cfg: ApplyConfig = { providers: 1, preference: 'auto', capable: true };
    const next = applyNext(cfg);
    const result = checkFiniteStateSafety({
      ...applyModel(cfg),
      next: (s) => {
        const out = next(s);
        // Mutant: skip the readiness probe entirely.
        if (s.phase === 'capable') {
          out.push({
            action: 'mutant:prepare-without-probe',
            state: { ...s, phase: 'prepared', prepares: s.prepares + 1 },
          });
        }
        return out;
      },
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('prepare requires a successful probe');
  });

  it('detects a phase-regression mutation', () => {
    const cfg: ApplyConfig = { providers: 1, preference: 'auto', capable: true };
    const next = applyNext(cfg);
    const result = checkFiniteStateSafety({
      ...applyModel(cfg),
      next: (s) => {
        const out = next(s);
        // Mutant: after a failed probe the pipeline restarts validation.
        if (s.phase === 'failed' && s.probes > 0) {
          out.push({
            action: 'mutant:revalidate',
            state: { ...s, phase: 'validated' },
          });
        }
        return out;
      },
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('a probe count implies the probe stage or beyond');
  });

  it('detects an echo-mismatch acceptance mutation', () => {
    const cfg: ApplyConfig = { providers: 1, preference: 'auto', capable: true };
    const next = applyNext(cfg);
    const result = checkFiniteStateSafety({
      ...applyModel(cfg),
      next: (s) =>
        next(s).map((step) =>
          // Mutant: report success even when the provider echo diverges.
          step.action === 'commit:mismatch'
            ? { ...step, state: { ...step.state, phase: 'done' as const } }
            : step
        ),
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('success requires an echo result');
  });
});

// ---------------------------------------------------------------------------
// Conformance: the production pipeline under scripted provider outcomes.
// ---------------------------------------------------------------------------

const request = (): VideoFilterRequest => ({
  source_id: 'camera-1',
  filter_id: 'color-1',
  type: 'color_correction',
  settings: { saturation: -1 },
});

function fakeProvider(id: string, events: string[], overrides: Partial<VideoFilterProvider> = {}) {
  const commit = vi.fn(async () => {
    events.push(`${id}:commit`);
    return { filter_id: 'color-1', type: 'color_correction' as const, enabled: true, index: 0 };
  });
  const provider: VideoFilterProvider = {
    provider_id: id,
    capabilities: { filter_types: ['color_correction'], local_only: true },
    probe: vi.fn(async () => {
      events.push(`${id}:probe`);
      return { available: true };
    }),
    list: vi.fn(async () => []),
    prepareApply: vi.fn(async () => {
      events.push(`${id}:prepare`);
      return { target_id: 'a'.repeat(64), commit };
    }),
    ...overrides,
  };
  return { provider, commit };
}

afterEach(() => resetVideoFilterProviders());

describe('applyVideoFilter conformance', () => {
  it('runs probe → prepare → approved op → commit in order, exactly once', async () => {
    const events: string[] = [];
    const fake = fakeProvider('software', events);
    registerVideoFilterProvider(fake.provider);
    external.mockImplementation(async (_op, commit) => {
      events.push('op');
      return commit();
    });
    const result = await applyVideoFilter(request());
    expect(result.filter_id).toBe('color-1');
    expect(events).toEqual(['software:probe', 'software:prepare', 'op', 'software:commit']);
    expect(external).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'video:filter_apply',
        requiresApproval: true,
        delegable: false,
      }),
      expect.any(Function),
      expect.any(Function)
    );
  });

  it('a denied approval never reaches commit', async () => {
    const events: string[] = [];
    const fake = fakeProvider('software', events);
    registerVideoFilterProvider(fake.provider);
    external.mockRejectedValueOnce(new Error('approval required'));
    await expect(applyVideoFilter(request())).rejects.toThrow('approval required');
    expect(events).toEqual(['software:probe', 'software:prepare']);
    expect(fake.commit).not.toHaveBeenCalled();
  });

  it('a failing probe contacts no other provider and stops before prepare', async () => {
    const events: string[] = [];
    const first = fakeProvider('software', events, {
      probe: vi.fn(async () => {
        events.push('software:probe');
        throw new Error('private transport detail');
      }),
    });
    const second = fakeProvider('alternate', events);
    registerVideoFilterProvider(first.provider);
    registerVideoFilterProvider(second.provider);
    await expect(applyVideoFilter(request(), 'software')).rejects.toThrow(
      '[VIDEO_FILTER_UNAVAILABLE]'
    );
    expect(events).toEqual(['software:probe']);
    expect(external).not.toHaveBeenCalled();
  });

  it('an ambiguous auto request fails before touching any provider', async () => {
    const events: string[] = [];
    registerVideoFilterProvider(fakeProvider('software', events).provider);
    registerVideoFilterProvider(fakeProvider('alternate', events).provider);
    await expect(applyVideoFilter(request())).rejects.toThrow('[VIDEO_FILTER_SELECTION_REQUIRED]');
    expect(events).toEqual([]);
    expect(external).not.toHaveBeenCalled();
  });

  it('a commit echo with a mismatched enabled flag is rejected', async () => {
    const events: string[] = [];
    const fake = fakeProvider('software', events, {
      prepareApply: vi.fn(async () => {
        events.push('software:prepare');
        return {
          target_id: 'b'.repeat(64),
          commit: vi.fn(async () => {
            events.push('software:commit');
            return {
              filter_id: 'color-1',
              type: 'color_correction' as const,
              enabled: false, // request asked for enabled: true
              index: 0,
            };
          }),
        };
      }),
    });
    registerVideoFilterProvider(fake.provider);
    external.mockImplementation(async (_op, commit) => commit());
    await expect(applyVideoFilter(request())).rejects.toThrow('[VIDEO_FILTER_UNVERIFIED]');
    expect(events).toEqual(['software:probe', 'software:prepare', 'software:commit']);
  });
});
