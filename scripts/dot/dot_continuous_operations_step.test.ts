import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { randomUUID } from 'node:crypto';
import { safeWriteFile, safeRmSync } from '@agent/core/secure-io';
import type { DotCharter, LoadedDotCharter } from '@agent/core/dot/dot-charter';
import { parseContinuousOperationsConfig } from '@agent/core/organization/continuous-operations-policy';
import { inspectContinuousCadence } from '../continuous/continuous_operations_cadence.js';
import {
  ContinuousOperationLane,
  runDotContinuousOperationsStep,
  type DotContinuousOperationsDeps,
} from './dot_continuous_operations_step.js';

vi.mock('@agent/core/ops-alert', () => ({ sendOpsAlert: vi.fn(async () => {}) }));

const now = new Date('2026-10-18T00:00:00Z');
const charter = {
  dot_id: 'operator',
  status: 'active',
  scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: 'ops' },
  authority: { authority_role: 'organization_operator' },
} as DotCharter;
const active: LoadedDotCharter[] = [{ path: 'dots/operator.json', charter }];
function config(tenant = 'acme', enabled = true) {
  return parseContinuousOperationsConfig({
    version: '1',
    loop_id: 'daily',
    dot_id: 'operator',
    enabled,
    scope: { ...charter.scope, tenant_slug: tenant },
    schedule: { every_seconds: 60 },
    sources: [{ source_id: 'health', kind: 'organization_metrics', max_age_seconds: 60 }],
    rules: [
      {
        rule_id: 'errors',
        source_id: 'health',
        metric: 'open_incidents',
        operator: 'gt',
        threshold: 0,
        objective_ref: 'reliability',
        title: 'Investigate',
        objective: 'Repair',
        pipeline_ref: 'pipelines/diagnose.json',
      },
    ],
    max_proposals_per_run: 3,
    cooldown_seconds: 60,
  });
}
function harness(overrides: Partial<DotContinuousOperationsDeps> = {}) {
  const state = new Map<string, unknown>();
  const runCycle = vi.fn(async () => {});
  const owner = vi.fn(async () => {});
  const deps: DotContinuousOperationsDeps = {
    rootDir: '/repo',
    configs: () => [
      { ref: 'knowledge/product/governance/continuous-operations/daily.json', config: config() },
    ],
    budgetHard: () => false,
    runAs: async (_c, callback) => callback(),
    lock: async (_key, callback) => callback(),
    readState: (file) => state.get(file),
    writeState: (file, value) => {
      state.set(file, value);
    },
    runCycle,
    owner,
    ...overrides,
  };
  return { state, runCycle, owner, deps };
}

describe('continuous resident cadence', () => {
  it('continues observations when repeated admission failures hold admission', async () => {
    const dotId = 'operator-admission-breaker';
    const scoped = [{ ...active[0], charter: { ...charter, dot_id: dotId } }];
    const runCycle = vi.fn(async (_ref, options) =>
      options.holdAdmission
        ? { inventory: [], admission_held: true }
        : { inventory: [{ disposition: 'error' }] as never }
    );
    const h = harness({
      runCycle,
      configs: () => [{ ref: 'daily.json', config: { ...config(), dot_id: dotId } }],
    });
    for (const n of [0, 1, 2]) {
      await expect(
        runDotContinuousOperationsStep(new Date(now.getTime() + n * 60_000), scoped, h.deps)
      ).rejects.toThrow(dotId);
    }
    await runDotContinuousOperationsStep(new Date(now.getTime() + 180_000), scoped, h.deps);
    expect(runCycle).toHaveBeenCalledTimes(4);
    expect(runCycle.mock.calls[3][1]).toMatchObject({ holdAdmission: true });
    expect([...h.state.values()][0]).toMatchObject({
      last_observation_at: new Date(now.getTime() + 180_000).toISOString(),
      last_admission_held: true,
      last_admission_error_count: 1,
    });
  });
  it('records observation completion and admission errors separately', async () => {
    const h = harness({
      runCycle: async () => ({
        inventory: [{ disposition: 'error' }] as never,
      }),
    });
    await expect(runDotContinuousOperationsStep(now, active, h.deps)).rejects.toThrow(
      'Continuous operations failed'
    );
    expect([...h.state.values()][0]).toEqual({
      version: 1,
      last_run_at: now.toISOString(),
      last_observation_at: now.toISOString(),
      last_admission_error_count: 1,
      last_withheld_sources: [],
    });
  });
  it('records partial progress without marking a cycle with a withheld collector complete', async () => {
    const h = harness({
      runCycle: async () => ({ inventory: [], withheld_sources: ['collector'] }),
    });
    await runDotContinuousOperationsStep(now, active, h.deps);
    const checkpoint = [...h.state.values()][0];
    expect(checkpoint).toMatchObject({
      last_observation_at: now.toISOString(),
      last_withheld_sources: ['collector'],
    });
    expect(checkpoint).not.toHaveProperty('last_success_at');
  });
  it('keeps a slow observation in flight while the advancement lane runs', async () => {
    const observation = new ContinuousOperationLane('observe', 1);
    const advance = new ContinuousOperationLane('advance', 1);
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });
    const collect = vi.fn(() => promise);
    const work = vi.fn(async () => {});
    observation.submit(active, collect);
    observation.submit(active, collect);
    advance.submit(active, work);
    await vi.waitFor(() => expect(work).toHaveBeenCalledOnce());
    expect(observation.inFlight).toBe(true);
    expect(collect).toHaveBeenCalledOnce();
    resolve();
    await vi.waitFor(() => expect(observation.inFlight).toBe(false));
  });
  it('projects the same due boundary and distinguishes an attempt from a completed tick', () => {
    const readState = vi.fn(() => ({
      version: 1,
      last_run_at: now.toISOString(),
    }));
    const before = new Date(now.getTime() + 59_999);
    const due = new Date(now.getTime() + 60_000);
    expect(inspectContinuousCadence(config(), undefined, { readState })).toMatchObject({
      status: 'charter_unavailable',
    });
    expect(inspectContinuousCadence(config('other'), charter, { readState })).toMatchObject({
      status: 'inactive',
    });
    expect(readState).not.toHaveBeenCalled();
    expect(inspectContinuousCadence(config(), charter, { now: before, readState })).toMatchObject({
      status: 'waiting',
      earliest_next_tick_at: due.toISOString(),
      last_success_at: null,
      latest_attempt_completed: false,
    });
    expect(inspectContinuousCadence(config(), charter, { now: due, readState })).toMatchObject({
      status: 'due',
    });
  });
  it('preserves the last completed cycle across a failed attempt and resumes on the next due tick', async () => {
    const cycle = vi.fn(async () => {});
    const h = harness({ runCycle: cycle });
    const tick = (seconds: number) => new Date(now.getTime() + seconds * 1000);

    // An earlier version recorded an attempt only.
    await runDotContinuousOperationsStep(tick(0), active, h.deps);
    const file = [...h.state.keys()][0];
    h.state.set(file, { version: 1, last_run_at: tick(0).toISOString() });
    await runDotContinuousOperationsStep(tick(60), active, h.deps);

    cycle.mockRejectedValueOnce(new Error('collector unavailable'));
    await expect(runDotContinuousOperationsStep(tick(120), active, h.deps)).rejects.toThrow(
      'Continuous operations failed'
    );
    expect(h.state.get(file)).toEqual({
      version: 1,
      last_run_at: tick(120).toISOString(),
      last_success_at: tick(60).toISOString(),
    });
    await runDotContinuousOperationsStep(tick(121), active, h.deps);
    expect(cycle).toHaveBeenCalledTimes(3);
    await runDotContinuousOperationsStep(tick(180), active, h.deps);
    expect(h.state.get(file)).toEqual({
      version: 1,
      last_run_at: tick(180).toISOString(),
      last_success_at: tick(180).toISOString(),
    });
  });
  it('keeps observing when the managed-owner circuit is open', async () => {
    const dotId = 'operator-owner-circuit';
    const scoped = [{ ...active[0], charter: { ...charter, dot_id: dotId } }];
    const owner = vi.fn().mockRejectedValue(new Error('managed owner unavailable'));
    const h = harness({
      owner,
      configs: () => [{ ref: 'daily.json', config: { ...config(), dot_id: dotId } }],
    });

    for (const minute of [0, 1, 2]) {
      await expect(
        runDotContinuousOperationsStep(new Date(now.getTime() + minute * 60_000), scoped, h.deps)
      ).rejects.toThrow(dotId);
    }
    await runDotContinuousOperationsStep(new Date(now.getTime() + 180_000), scoped, h.deps);

    expect(owner).toHaveBeenCalledTimes(3);
    expect(h.runCycle).toHaveBeenCalledTimes(4);
  });
  it('runs once when due and catches up only once after downtime', async () => {
    const h = harness();
    await runDotContinuousOperationsStep(now, active, h.deps);
    await runDotContinuousOperationsStep(new Date(now.getTime() + 59_000), active, h.deps);
    expect(h.runCycle).toHaveBeenCalledTimes(1);
    await runDotContinuousOperationsStep(new Date(now.getTime() + 86_400_000), active, h.deps);
    expect(h.runCycle).toHaveBeenCalledTimes(2);
    expect(h.owner).toHaveBeenCalledTimes(3);
  });
  it('filters other tenants before source execution', async () => {
    const h = harness({ configs: () => [{ ref: 'other.json', config: config('other') }] });
    await runDotContinuousOperationsStep(now, active, h.deps);
    expect(h.runCycle).not.toHaveBeenCalled();
    expect(h.state.size).toBe(0);
  });
  it('continues pending owner work when the source loop is disabled', async () => {
    const h = harness({ configs: () => [{ ref: 'disabled.json', config: config('acme', false) }] });
    await runDotContinuousOperationsStep(now, active, h.deps);
    expect(h.runCycle).not.toHaveBeenCalled();
    expect(h.owner).toHaveBeenCalledOnce();
  });
  it('fails closed on malformed persistent cadence state and still services owner', async () => {
    const h = harness({ readState: () => ({ version: 1, last_run_at: 'bad' }) });
    await expect(runDotContinuousOperationsStep(now, active, h.deps)).rejects.toThrow('failed');
    expect(h.runCycle).not.toHaveBeenCalled();
    expect(h.state.size).toBe(0);
    expect(h.owner).toHaveBeenCalledOnce();
  });
  it('checkpoints before execution and does not storm after a failure', async () => {
    const h = harness();
    h.runCycle.mockImplementation(async () => {
      expect(h.state.size).toBe(1);
      throw new Error('source down');
    });
    await expect(runDotContinuousOperationsStep(now, active, h.deps)).rejects.toThrow('failed');
    await runDotContinuousOperationsStep(new Date(now.getTime() + 1_000), active, h.deps);
    expect(h.runCycle).toHaveBeenCalledOnce();
    expect(h.owner).toHaveBeenCalledTimes(2);
  });
  it('skips all execution at hard budget limit', async () => {
    const h = harness({ budgetHard: () => true });
    await runDotContinuousOperationsStep(now, active, h.deps);
    expect(h.runCycle).not.toHaveBeenCalled();
    expect(h.owner).not.toHaveBeenCalled();
  });
  it('surfaces catalog discovery failure to the enclosing supervisor', async () => {
    const h = harness({
      configs: () => {
        throw new Error('invalid catalog');
      },
    });
    await expect(runDotContinuousOperationsStep(now, active, h.deps)).rejects.toThrow('failed');
    expect(h.owner).toHaveBeenCalledOnce();
  });
  it('isolates malformed configuration while running valid loops and pending owners', async () => {
    const rootDir = path.join(
      pathResolver.rootDir(),
      'active/shared/tmp',
      `continuous-discovery-${randomUUID()}`
    );
    const directory = path.join(rootDir, 'knowledge/product/governance/continuous-operations');
    try {
      safeWriteFile(path.join(directory, 'bad.json'), '{broken');
      safeWriteFile(path.join(directory, 'good.json'), JSON.stringify(config()));
      const h = harness({ rootDir, configs: undefined });
      await expect(runDotContinuousOperationsStep(now, active, h.deps)).rejects.toThrow('bad.json');
      expect(h.runCycle).toHaveBeenCalledOnce();
      expect(h.owner).toHaveBeenCalledOnce();
    } finally {
      safeRmSync(rootDir, { recursive: true, force: true });
    }
  });
});
