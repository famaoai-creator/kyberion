import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { observePipelineScheduleDependencies } from './recurring-work-observation.js';
import {
  registerScheduledPipeline,
  type ScheduledPipeline,
} from '../pipeline/pipeline-scheduler.js';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync, safeWriteFile } from '../secure-io.js';

const scope = { tier: 'confidential', tenant_slug: 'acme' } as const;
const ref = 'knowledge/confidential/acme/pipelines/check.json';
const now = new Date('2026-11-22T00:00:00Z');
function schedule(id: string, pipelinePath: string): ScheduledPipeline {
  return {
    id,
    name: id,
    pipelinePath,
    actuator: 'system',
    enabled: false,
    trigger: { type: 'interval', intervalMs: 60_000 },
    lastRun: now.toISOString(),
    lastStatus: 'failed',
    lastError: 'private runtime details',
  };
}
describe('recurring work observation', () => {
  it('preserves uncertainty when an opt-in schedule could be due', () => {
    expect(
      observePipelineScheduleDependencies(scope, [ref], {
        rootDir: '/repo',
        now: new Date(now.getTime() + 60_000),
        realpath: (file) => file,
        list: () => [{ ...schedule('check', ref), optIn: true }],
      })
    ).toMatchObject([
      {
        registration: 'requires_opt_in',
        timing_due: null,
        potentially_due: true,
      },
    ]);
  });
  it('does not infer Chronos host policy from the observer environment', () => {
    vi.stubEnv('KYBERION_CHRONOS_SCHEDULES', 'different-job');
    try {
      const rows = observePipelineScheduleDependencies(scope, [ref], {
        rootDir: '/repo',
        now: new Date(now.getTime() + 60_000),
        realpath: (file) => file,
        list: () => [{ ...schedule('check', ref), enabled: true }],
      });
      expect(rows).toMatchObject([
        {
          registration: 'enabled',
          execution_eligibility: 'chronos_policy_unobserved',
          last_result: 'failed',
          timing_due: true,
        },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('reads the existing scheduler registry from an isolated workspace', () => {
    const rootDir = pathResolver.sharedTmp('recurring-work-observation-' + randomUUID());
    try {
      safeWriteFile(rootDir + '/' + ref, '{}');
      registerScheduledPipeline(schedule('check', ref), { rootDir });
      expect(observePipelineScheduleDependencies(scope, [ref], { rootDir, now })).toMatchObject([
        { schedule_id: 'check', status: 'failing', last_run_at: now.toISOString() },
      ]);
    } finally {
      safeRmSync(rootDir, { recursive: true, force: true });
    }
  });
  it('exposes status only for declared dependencies in matching path custody', () => {
    const foreign = ref.replace('/acme/', '/other/');
    const rows = observePipelineScheduleDependencies(
      scope,
      [ref, foreign, 'pipelines/global.json'],
      {
        rootDir: '/repo',
        now,
        realpath: (file) => file,
        list: () => [
          schedule('check', ref),
          schedule('tenant-acme-foreign', foreign),
          schedule('global', 'pipelines/global.json'),
          schedule('undeclared', ref.replace('check.json', 'undeclared.json')),
        ],
      }
    );
    expect(rows).toEqual([
      {
        schedule_id: 'check',
        pipeline_ref: ref,
        relationship: 'scheduled_dependency',
        registration: 'disabled',
        execution_eligibility: 'disabled_in_registry',
        last_result: 'failed',
        timing_due: false,
        potentially_due: false,
        status: 'failing',
        last_run_at: now.toISOString(),
      },
    ]);
  });
  it('rejects a declared schedule whose target redirects to a different path', () => {
    expect(() =>
      observePipelineScheduleDependencies(scope, [ref], {
        rootDir: '/repo',
        now,
        list: () => [schedule('check', ref)],
        realpath: (file) => (file === '/repo' ? file : '/repo/other.json'),
      })
    ).toThrow('symlinks');
  });
});
