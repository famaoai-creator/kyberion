import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The runner is a measurement entry point: it must build its own
// caller-bounded backend, never borrow the installed (route-wrapped,
// 60s-limited) chain, and bound every probe itself.
const mocks = vi.hoisted(() => ({
  buildTaskReasoningBackend: vi.fn(),
  getReasoningBackend: vi.fn(() => {
    throw new Error('the installed chain must not be measured');
  }),
}));

vi.mock('./reasoning-bootstrap.js', () => ({
  buildTaskReasoningBackend: mocks.buildTaskReasoningBackend,
}));

vi.mock('./reasoning-backend.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./reasoning-backend.js')>()),
  getReasoningBackend: mocks.getReasoningBackend,
}));

vi.mock('../provider/provider-egress-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../provider/provider-egress-gate.js')>()),
  // Skip the provider-match refusal: it is not what these tests measure.
  providerIdForReasoningIdentifier: () => undefined,
}));

import {
  ROLE_FITNESS_PROBE_TIMEOUT_MS,
  runModelRoleFitnessProbes,
} from './model-role-fitness-runner.js';
import { listRoleFitnessProbes } from './model-role-fitness.js';

describe('model role fitness runner (measurement entry point)', () => {
  beforeEach(() => {
    mocks.buildTaskReasoningBackend.mockReset();
    mocks.getReasoningBackend.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a caller-bounded backend instead of using the installed chain', async () => {
    mocks.buildTaskReasoningBackend.mockReturnValue({
      name: 'test-provider',
      prompt: async () => 'answer',
    });
    const result = await runModelRoleFitnessProbes({
      modelId: 'model-x',
      provider: 'test-provider',
      teamRole: 'reviewer',
      record: false,
    });
    expect(result.status).toBe('completed');
    expect(mocks.buildTaskReasoningBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        requestTimeout: 'caller',
        timeoutMs: ROLE_FITNESS_PROBE_TIMEOUT_MS,
      })
    );
    expect(mocks.getReasoningBackend).not.toHaveBeenCalled();
  });

  it('keeps a probe answered after the route default 60s', async () => {
    vi.useFakeTimers();
    // The answer is held on deferreds and released only after 61s of fake
    // time, so the runner's own ceiling (not a 60s route limit) is in force.
    const releases: Array<(answer: string) => void> = [];
    mocks.buildTaskReasoningBackend.mockReturnValue({
      name: 'test-provider',
      prompt: () =>
        new Promise<string>((resolve) => {
          releases.push(resolve);
        }),
    });
    const pending = runModelRoleFitnessProbes({
      modelId: 'model-x',
      provider: 'test-provider',
      teamRole: 'reviewer',
      record: false,
    });
    const probes = listRoleFitnessProbes('reviewer');
    for (let i = 0; i < probes.length; i++) {
      await vi.waitFor(() => expect(releases).toHaveLength(i + 1));
      await vi.advanceTimersByTimeAsync(61_000);
      releases[i]!('slow but complete answer');
    }
    const result = await pending;
    expect(result.evaluations).toHaveLength(probes.length);
  });

  it('bounds each probe itself, aborting and dropping one past the ceiling', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    mocks.buildTaskReasoningBackend.mockReturnValue({
      name: 'test-provider',
      prompt: (_prompt: string, options?: { signal?: AbortSignal }) => {
        if (options?.signal) signals.push(options.signal);
        return new Promise<string>(() => {});
      },
    });
    const pending = runModelRoleFitnessProbes({
      modelId: 'model-x',
      provider: 'test-provider',
      teamRole: 'reviewer',
      record: false,
      probeTimeoutMs: 1_000,
    });
    const probes = listRoleFitnessProbes('reviewer');
    for (let i = 0; i < probes.length; i++) await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result.status).toBe('completed');
    expect(result.evaluations).toHaveLength(0);
    expect(signals).toHaveLength(probes.length);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports backend_unavailable when no measurement backend can be built', async () => {
    mocks.buildTaskReasoningBackend.mockImplementation(() => {
      throw new Error('No usable task reasoning backend');
    });
    const result = await runModelRoleFitnessProbes({
      modelId: 'model-x',
      provider: 'test-provider',
      record: false,
    });
    expect(result).toMatchObject({
      status: 'backend_unavailable',
      detail: expect.stringContaining('No usable task reasoning backend'),
    });
  });
});
