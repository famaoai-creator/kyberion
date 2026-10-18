import { describe, it, expect, vi } from 'vitest';
const cycle = vi.hoisted(() => vi.fn());
vi.mock('./continuous_operations_cycle.js', () => ({
  runContinuousOperationsCycleFromRef: cycle,
  runContinuousOperationsCycle: cycle,
}));
import {
  loadContinuousOperationsConfig,
  assertContinuousOperationsSelectedScope,
  runOrganizationContinuousOperations,
  CONTINUOUS_CONFIG_ROOT,
} from './organization_continuous_operations.js';
import type { ContinuousOperationsConfig } from '@agent/core/organization/continuous-operations-policy';

const config: ContinuousOperationsConfig = {
  version: '1',
  loop_id: 'test-loop',
  dot_id: 'test-dot',
  scope: {
    tier: 'confidential',
    tenant_slug: 'acme',
    organization_id: 'org-a',
    project_id: 'prj-a',
  },
  enabled: true,
  max_proposals_per_run: 1,
  cooldown_seconds: 60,
  sources: [
    {
      source_id: 'metrics',
      path: 'active/shared/runtime/confidential/acme/metrics/latest.json',
      max_age_seconds: 60,
    },
  ],
  rules: [
    {
      rule_id: 'failures',
      source_id: 'metrics',
      metric: 'failures',
      operator: 'gt',
      threshold: 0,
      objective_ref: 'objective:reliability',
      title: 'Investigate',
      objective: 'Diagnose failures',
      pipeline_ref: 'pipelines/ops-health-probe.json',
    },
  ],
};
const ref = CONTINUOUS_CONFIG_ROOT + 'test.json';
describe('continuous operations organization facade', () => {
  it.each([
    'active/shared/staging/injected.json',
    CONTINUOUS_CONFIG_ROOT + '../injected.json',
    '/tmp/config.json',
    CONTINUOUS_CONFIG_ROOT + 'testxjson',
  ])('rejects untrusted config ref %s', (value) => {
    const read = vi.fn();
    expect(() =>
      loadContinuousOperationsConfig(value, { read, realpath: (file) => file })
    ).toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects a trusted pathname redirected by a symlink', () => {
    const read = vi.fn();
    expect(() =>
      loadContinuousOperationsConfig(ref, { read, realpath: () => '/tmp/untrusted.json' })
    ).toThrow('symlink');
    expect(read).not.toHaveBeenCalled();
  });
  it('loads and validates reviewed config', () => {
    expect(
      loadContinuousOperationsConfig(ref, {
        rootDir: '/repo',
        realpath: (file) => file,
        read: () => config,
      })
    ).toEqual(config);
  });
  it('requires exact selected scope, including project', () => {
    expect(() => assertContinuousOperationsSelectedScope(config, config.scope)).not.toThrow();
    for (const scope of [
      { ...config.scope, tier: 'public' as const },
      { ...config.scope, tenant_slug: 'other' },
      { ...config.scope, organization_id: 'org-b' },
      { ...config.scope, project_id: undefined },
    ])
      expect(() => assertContinuousOperationsSelectedScope(config, scope)).toThrow('matching');
  });
  it.each(
    [
      [],
      ['--config', ref],
      ['--config', ref, '--dry-run', '--apply'],
      ['--config', ref, '--apply', '--apply'],
      ['--config', ref, '--dry-run', '--recover-admissions'],
      ['--config', ref, '--apply', '--unknown'],
    ].map((args) => [args])
  )('rejects ambiguous or invalid arguments %j', async (args) => {
    const run = vi.fn();
    await expect(runOrganizationContinuousOperations(args, vi.fn(), { run })).rejects.toThrow(
      'Usage'
    );
    expect(run).not.toHaveBeenCalled();
  });
  it('checks scope before binding or running', async () => {
    const run = vi.fn();
    const bind = vi.fn();
    await expect(
      runOrganizationContinuousOperations(['--config', ref, '--apply'], vi.fn(), {
        load: () => config,
        selectedScope: () => {
          throw new Error('scope mismatch');
        },
        run,
        bind,
      })
    ).rejects.toThrow('scope mismatch');
    expect(bind).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it('previews without apply and forwards explicit recovery only on apply', async () => {
    const run = vi.fn(() => ({
      loop_id: config.loop_id,
      scope: config.scope,
      applied: false,
      state_path: '/state',
      inventory: [],
    }));
    const print = vi.fn();
    const deps = {
      load: () => config,
      selectedScope: vi.fn(),
      run,
      bind: (_config: ContinuousOperationsConfig, fn: () => unknown) => fn(),
    };
    await runOrganizationContinuousOperations(
      ['--config', ref, '--dry-run', '--json'],
      print,
      deps
    );
    expect(run).toHaveBeenLastCalledWith(config, { apply: false, recoverAdmissions: false });
    await runOrganizationContinuousOperations(
      ['--config', ref, '--apply', '--recover-admissions', '--json'],
      print,
      deps
    );
    expect(run).toHaveBeenLastCalledWith(config, { apply: true, recoverAdmissions: true });
    expect(print).toHaveBeenCalledTimes(2);
  });
  it('awaits an asynchronous binding before printing', async () => {
    const report = {
      loop_id: config.loop_id,
      scope: config.scope,
      applied: false,
      state_path: '/state',
      inventory: [],
    };
    const print = vi.fn();
    await runOrganizationContinuousOperations(['--config', ref, '--dry-run', '--json'], print, {
      load: () => config,
      selectedScope: vi.fn(),
      run: () => report,
      bind: async (_config, run) => {
        await Promise.resolve();
        return run();
      },
    });
    expect(print).toHaveBeenCalledWith(report);
  });
  it('connects the default command to the full asynchronous cycle', async () => {
    const report = {
      loop_id: config.loop_id,
      scope: config.scope,
      applied: false,
      state_path: '/state',
      inventory: [],
    };
    cycle.mockResolvedValueOnce(report);
    const print = vi.fn();
    await runOrganizationContinuousOperations(['--config', ref, '--dry-run', '--json'], print, {
      load: () => config,
      selectedScope: vi.fn(),
      bind: async (_config, run) => run(),
    });
    expect(cycle).toHaveBeenCalledWith(config, { apply: false, recoverAdmissions: false });
    expect(print).toHaveBeenCalledWith(report);
  });
  it('fails the command after printing a failed admission report', async () => {
    const print = vi.fn();
    const report = {
      loop_id: config.loop_id,
      scope: config.scope,
      applied: true,
      state_path: '/state',
      inventory: [
        {
          rule_id: 'failures',
          disposition: 'error' as const,
          current_value: 1,
          observed_at: '2026-10-18T00:00:00Z',
          objective_ref: 'objective:reliability',
          evidence_refs: [],
          error: 'refused',
        },
      ],
    };
    await expect(
      runOrganizationContinuousOperations(['--config', ref, '--apply', '--json'], print, {
        load: () => config,
        selectedScope: vi.fn(),
        bind: (_config, fn) => fn(),
        run: () => report,
      })
    ).rejects.toThrow('admission failed');
    expect(print).toHaveBeenCalledWith(report);
  });
});
