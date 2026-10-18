import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeWriteFile, safeRmSync } from '@agent/core/secure-io';
import type { DotCharter, LoadedDotCharter } from '@agent/core/dot/dot-charter';
import { parseContinuousOperationsConfig } from '@agent/core/organization/continuous-operations-policy';
import {
  runDotContinuousOperationsStep,
  type DotContinuousOperationsDeps,
} from './dot_continuous_operations_step.js';

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
      process.cwd(),
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
