import { describe, expect, it, vi } from 'vitest';
import { dotStatePath } from '../dot/dot-state-paths.js';
import type { DotCharter } from '../dot/dot-charter.js';
import { withExecutionContext } from '../authority.js';
import type { ContinuousOperationsConfig } from './continuous-operations-policy.js';
import {
  assertContinuousOperationsCollectionAuthority,
  assertContinuousOperationsReconciliationAuthority,
  collectContinuousOperationsSources,
} from './continuous-operations-sources.js';

const now = new Date('2026-10-18T00:00:00Z');
const charter = {
  dot_id: 'operator',
  status: 'active',
  scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: 'ops' },
  authority: {
    authority_role: 'organization_operator',
    allowed_pipelines: ['pipelines/collect.json'],
  },
} as DotCharter;
function config(source: object = { kind: 'organization_metrics' }) {
  return {
    version: '1',
    loop_id: 'daily',
    dot_id: 'operator',
    enabled: true,
    scope: charter.scope,
    sources: [{ source_id: 'health', max_age_seconds: 60, ...source }],
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
  };
}
const observation = (date = now) => [
  {
    metric: 'open_incidents',
    value: 1,
    observed_at: date.toISOString(),
    evidence_ref: 'incident:count',
  },
];
const options = { charter, now, rootDir: '/repo', apply: true };

describe('continuous source collection', () => {
  it('allows exact-scope reconciliation while the charter is paused and execution is fenced', () => {
    const input = config() as ContinuousOperationsConfig;
    const paused = { ...charter, status: 'paused' as const };
    withExecutionContext(
      'organization_operator',
      () => {
        expect(() => assertContinuousOperationsCollectionAuthority(input, paused)).toThrow(
          'active charter'
        );
        expect(() =>
          assertContinuousOperationsReconciliationAuthority(input, paused)
        ).not.toThrow();
        expect(() =>
          assertContinuousOperationsReconciliationAuthority(input, {
            ...paused,
            scope: { ...paused.scope, project_id: 'unrelated-project' },
          })
        ).toThrow('exact charter scope');
      },
      undefined,
      'acme',
      'ops'
    );
    expect(() =>
      withExecutionContext(
        'organization_operator',
        () => assertContinuousOperationsReconciliationAuthority(input, paused),
        undefined,
        'acme',
        'other-organization'
      )
    ).toThrow();
  });

  it.each(['snapshot', 'pipeline'] as const)(
    'reads a personal %s only from the current charter owner namespace',
    async (kind) => {
      const scope = { tier: 'personal' as const, organization_id: 'ops' };
      const active = { ...charter, scope: { ...scope, owner_nhi: 'owner-b' } };
      const prior = { ...charter, scope: { ...scope, owner_nhi: 'owner-a' } };
      const sourcePath = (owner: DotCharter) =>
        dotStatePath(owner, 'continuous-operations', 'snapshots', 'health.json');
      const settings = (file: string) => ({
        ...config({
          kind,
          path: file,
          ...(kind === 'pipeline' ? { pipeline_ref: 'pipelines/collect.json' } : {}),
        }),
        scope,
      });
      const read = vi.fn(() => observation());
      const executePipeline = vi.fn(async () => {});
      const deps = { authorize: () => {}, read, executePipeline, clock: () => now };
      const collect = (file: string) =>
        collectContinuousOperationsSources(settings(file), { ...options, charter: active }, deps);
      await expect(collect('active/shared/runtime/personal/shared/health.json')).rejects.toThrow(
        'outside configured scope'
      );
      await expect(collect(sourcePath(prior))).rejects.toThrow('current personal owner');
      expect(read).not.toHaveBeenCalled();
      expect(executePipeline).not.toHaveBeenCalled();
      await expect(collect(sourcePath(active))).resolves.toEqual([
        { source_id: 'health', observations: observation() },
      ]);
      expect(read).toHaveBeenCalledOnce();
    }
  );

  it('observes a scheduled dependency through the existing rule input without running it', async () => {
    const ref = 'knowledge/confidential/acme/pipelines/check.json';
    const input = config({ kind: 'pipeline_schedule_health', pipeline_ref: ref });
    input.rules[0].metric = 'failing_pipeline_schedules';
    const schedules = vi.fn(() => [
      {
        schedule_id: 'check',
        pipeline_ref: ref,
        relationship: 'scheduled_dependency' as const,
        registration: 'enabled',
        execution_eligibility: 'chronos_policy_unobserved',
        last_result: 'failed' as const,
        timing_due: false,
        potentially_due: false,
        status: 'failing',
        last_run_at: now.toISOString(),
      },
    ]);
    const executePipeline = vi.fn();
    const result = await collectContinuousOperationsSources(input, options, {
      authorize: () => {},
      executePipeline,
      schedules,
    });
    expect(schedules).toHaveBeenCalledWith(charter.scope, [ref], { rootDir: '/repo', now });
    expect(executePipeline).not.toHaveBeenCalled();
    expect(result[0].observations).toContainEqual({
      metric: 'failing_pipeline_schedules',
      value: 1,
      observed_at: now.toISOString(),
      evidence_ref: `schedule-registry:${ref}/failing_pipeline_schedules`,
    });
    await expect(
      collectContinuousOperationsSources(
        config({
          kind: 'pipeline_schedule_health',
          pipeline_ref: ref.replace('/acme/', '/other/'),
        }),
        options,
        { authorize: () => {}, schedules }
      )
    ).rejects.toThrow('configured custody');
    expect(schedules).toHaveBeenCalledOnce();
  });
  it('withholds fresh output from a different collector attempt and accepts the exact attempt', async () => {
    const source = config({
      kind: 'pipeline',
      pipeline_ref: 'pipelines/collect.json',
      path: 'active/shared/runtime/confidential/acme/health.json',
    });
    const optionsWithHold = { ...options, withheldSources: new Set<string>() };
    const deps = {
      authorize: () => {},
      clock: () => now,
      executePipeline: async (
        _ref: string,
        _charter: DotCharter,
        capture: (attemptId: string) => void
      ) => capture('current-attempt'),
      read: vi.fn(() => ({
        collector_attempt_id: 'previous-attempt',
        observations: observation(),
      })),
    };
    await expect(
      collectContinuousOperationsSources(source, optionsWithHold, deps)
    ).resolves.toEqual([]);
    expect([...optionsWithHold.withheldSources]).toEqual(['health']);

    optionsWithHold.withheldSources.clear();
    deps.read.mockReturnValueOnce({
      collector_attempt_id: 'current-attempt',
      observations: observation(),
    });
    await expect(
      collectContinuousOperationsSources(source, optionsWithHold, deps)
    ).resolves.toEqual([{ source_id: 'health', observations: observation() }]);
  });

  it('rejects distinct collector pipelines configured to overwrite the same output', async () => {
    const input = config({
      kind: 'pipeline',
      pipeline_ref: 'pipelines/collect.json',
      path: 'active/shared/runtime/confidential/acme/health.json',
    });
    input.sources.push({
      ...input.sources[0],
      source_id: 'other',
      pipeline_ref: 'pipelines/other.json',
    } as (typeof input.sources)[number]);
    await expect(
      collectContinuousOperationsSources(input, options, { authorize: () => {} })
    ).rejects.toThrow('output path cannot be shared');
  });

  it('accepts a snapshot timestamp produced after an awaited collector started', async () => {
    const completedAt = new Date(now.getTime() + 5_000);
    const result = await collectContinuousOperationsSources(
      config({
        kind: 'pipeline',
        pipeline_ref: 'pipelines/collect.json',
        path: 'active/shared/runtime/confidential/acme/health.json',
      }),
      options,
      {
        authorize: () => {},
        clock: () => completedAt,
        executePipeline: async () => {},
        read: () => observation(completedAt),
      }
    );
    expect(result[0].observations[0].observed_at).toBe(completedAt.toISOString());
    await expect(
      collectContinuousOperationsSources(
        config({
          kind: 'pipeline',
          pipeline_ref: 'pipelines/collect.json',
          path: 'active/shared/runtime/confidential/acme/health.json',
        }),
        options,
        {
          authorize: () => {},
          clock: () => completedAt,
          executePipeline: async () => {},
          read: () => observation(new Date(completedAt.getTime() + 1)),
        }
      )
    ).rejects.toThrow();
  });
  it('authorizes before any source access and rejects unbound execution', async () => {
    const metrics = vi.fn();
    await expect(
      collectContinuousOperationsSources(config(), options, { metrics })
    ).rejects.toThrow();
    expect(metrics).not.toHaveBeenCalled();
  });
  it('passes the exact bound config to metrics and returns counts with collection time', async () => {
    const metrics = vi.fn(() => ({ open_incidents: 2 }));
    const result = await collectContinuousOperationsSources(config(), options, {
      authorize: () => {},
      metrics,
    });
    expect(metrics.mock.calls[0]).toEqual([
      expect.objectContaining({ scope: charter.scope }),
      '/repo',
    ]);
    expect(result).toEqual([
      {
        source_id: 'health',
        observations: [
          {
            metric: 'open_incidents',
            value: 2,
            observed_at: now.toISOString(),
            evidence_ref: 'organization:ops/metrics/open_incidents',
          },
        ],
      },
    ]);
  });
  it('does not collect disabled sources', async () => {
    const metrics = vi.fn();
    expect(
      await collectContinuousOperationsSources({ ...config(), enabled: false }, options, {
        authorize: () => {},
        metrics,
      })
    ).toEqual([]);
    expect(metrics).not.toHaveBeenCalled();
  });
  it('rejects non-allowlisted pipeline before execution or reading', async () => {
    const executePipeline = vi.fn();
    const read = vi.fn();
    await expect(
      collectContinuousOperationsSources(
        config({
          kind: 'pipeline',
          pipeline_ref: 'pipelines/forbidden.json',
          path: 'active/shared/runtime/confidential/acme/health.json',
        }),
        options,
        { authorize: () => {}, executePipeline, read }
      )
    ).rejects.toThrow('permitted');
    expect(executePipeline).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it('does not consume an old snapshot after collector failure', async () => {
    const read = vi.fn(() => observation());
    await expect(
      collectContinuousOperationsSources(
        config({
          kind: 'pipeline',
          pipeline_ref: 'pipelines/collect.json',
          path: 'active/shared/runtime/confidential/acme/health.json',
        }),
        options,
        {
          authorize: () => {},
          executePipeline: async () => {
            throw new Error('collector unavailable');
          },
          read,
        }
      )
    ).rejects.toThrow('unavailable');
    expect(read).not.toHaveBeenCalled();
  });
  it('preserves snapshot freshness and rejects stale collector output', async () => {
    const source = {
      kind: 'pipeline',
      pipeline_ref: 'pipelines/collect.json',
      path: 'active/shared/runtime/confidential/acme/health.json',
    };
    await expect(
      collectContinuousOperationsSources(config(source), options, {
        authorize: () => {},
        executePipeline: async () => {},
        read: () => observation(new Date(now.getTime() - 61_000)),
      })
    ).rejects.toThrow();
  });
  it('dry-run reads existing snapshots without executing pipelines', async () => {
    const executePipeline = vi.fn();
    await collectContinuousOperationsSources(
      config({
        kind: 'pipeline',
        pipeline_ref: 'pipelines/collect.json',
        path: 'active/shared/runtime/confidential/acme/health.json',
      }),
      { ...options, apply: false },
      { authorize: () => {}, executePipeline, read: () => observation() }
    );
    expect(executePipeline).not.toHaveBeenCalled();
  });
});
