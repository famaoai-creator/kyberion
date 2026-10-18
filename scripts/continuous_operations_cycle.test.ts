import { describe, it, expect, vi } from 'vitest';
const executePipelineFile = vi.hoisted(() => vi.fn());
vi.mock('./lib/pipeline-file-runner.js', () => ({ pipelineFileRunner: () => executePipelineFile }));
import { runContinuousOperationsCycle } from './continuous_operations_cycle.js';
import type { ContinuousOperationsConfig } from '@agent/core/organization/continuous-operations-policy';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import type { DotDispatchResult } from '@agent/core/dot/dot-dispatch';
const now = new Date('2026-10-18T06:00:00.000Z');
const config: ContinuousOperationsConfig = {
  version: '1',
  loop_id: 'ops',
  dot_id: 'ops',
  scope: { tier: 'public', organization_id: 'org' },
  enabled: true,
  max_proposals_per_run: 1,
  cooldown_seconds: 60,
  sources: [{ source_id: 'org', kind: 'organization_metrics', max_age_seconds: 60 }],
  rules: [
    {
      rule_id: 'incidents',
      source_id: 'org',
      metric: 'open_incidents',
      operator: 'gt',
      threshold: 0,
      objective_ref: 'availability',
      title: 'Investigate',
      objective: 'Produce scoped evidence',
      pipeline_ref: 'pipelines/report.json',
    },
  ],
};
function fixture() {
  const files = new Map<string, unknown>();
  const dispatch = vi.fn(
    () =>
      ({
        records: [{ status: 'dispatched', action_ref: 'action', work_item_id: 'item' }],
        duplicates: [],
      }) as unknown as DotDispatchResult
  );
  const write = vi.fn((file: string, value: unknown) => files.set(file, structuredClone(value)));
  const charter = {
    dot_id: 'ops',
    status: 'active',
    scope: config.scope,
    authority: {
      authority_role: 'organization_operator',
      allowed_pipelines: ['pipelines/collector.json'],
    },
  } as DotCharter;
  const deps = {
    charter: () => charter,
    collection: { authorize: () => undefined, metrics: () => ({ open_incidents: 2 }) },
    runtime: {
      authorize: () => undefined,
      charters: () => [charter],
      read: (file: string) => structuredClone(files.get(file)),
      write,
      exists: (file: string) => files.has(file),
      lock: <T>(_key: string, fn: () => T) => fn(),
      dispatch,
    },
    outcomes: vi.fn(() => [{ status: 'observed' }]),
  };
  return { deps, dispatch, write, files };
}
describe('full continuous observation cycle', () => {
  it('runs the production collector port from the config-based CLI cycle path', async () => {
    const f = fixture();
    const changed = {
      ...config,
      sources: [
        {
          source_id: 'org',
          kind: 'pipeline' as const,
          pipeline_ref: 'pipelines/collector.json',
          path: 'active/shared/runtime/public/shared/metrics.json',
          max_age_seconds: 60,
        },
      ],
    };
    executePipelineFile.mockResolvedValueOnce({
      status: 'succeeded',
      results: [{ status: 'succeeded' }],
    });
    const report = await runContinuousOperationsCycle(
      changed,
      { apply: true, now, rootDir: '/repo' },
      {
        ...f.deps,
        clock: () => now,
        collection: {
          ...f.deps.collection,
          read: () => [
            {
              metric: 'open_incidents',
              value: 1,
              observed_at: now.toISOString(),
              evidence_ref: 'source:latest',
            },
          ],
        },
      }
    );
    expect(executePipelineFile).toHaveBeenLastCalledWith(
      'pipelines/collector.json',
      expect.objectContaining({
        context: { tier: 'public', tenant_slug: undefined, organization_id: 'org' },
        hasHuman: false,
      })
    );
    expect(report.inventory[0].disposition).toBe('proposed');
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it('rejects an unsuccessful overall collector result before consuming its snapshot', async () => {
    const f = fixture(),
      read = vi.fn();
    const changed = {
      ...config,
      sources: [
        {
          source_id: 'org',
          kind: 'pipeline' as const,
          pipeline_ref: 'pipelines/collector.json',
          path: 'active/shared/runtime/public/shared/metrics.json',
          max_age_seconds: 60,
        },
      ],
    };
    executePipelineFile.mockResolvedValueOnce({ status: 'failed', results: [] });
    await expect(
      runContinuousOperationsCycle(
        changed,
        { apply: true, now, rootDir: '/repo' },
        { ...f.deps, collection: { ...f.deps.collection, read } }
      )
    ).rejects.toThrow('collector pipeline failed');
    expect(read).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('collects real-shaped metrics and previews without admitting or persisting', async () => {
    const f = fixture();
    const report = await runContinuousOperationsCycle(
      config,
      { apply: false, now, rootDir: '/repo' },
      f.deps
    );
    expect(report.inventory[0]).toMatchObject({
      disposition: 'proposed',
      current_value: 2,
      evidence_refs: ['organization:org/metrics/open_incidents'],
    });
    expect(report.outcomes).toEqual([{ status: 'observed' }]);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it('connects collection to admission and preserves episode dedup across cycles', async () => {
    const f = fixture();
    await runContinuousOperationsCycle(config, { apply: true, now, rootDir: '/repo' }, f.deps);
    const second = await runContinuousOperationsCycle(
      config,
      { apply: true, now, rootDir: '/repo' },
      f.deps
    );
    expect(second.inventory[0].disposition).toBe('duplicate');
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('does not admit work after collector failure', async () => {
    const f = fixture();
    const changed = {
      ...config,
      sources: [
        {
          source_id: 'org',
          kind: 'pipeline' as const,
          pipeline_ref: 'pipelines/collector.json',
          path: 'active/shared/runtime/public/shared/metrics.json',
          max_age_seconds: 60,
        },
      ],
    };
    await expect(
      runContinuousOperationsCycle(
        changed,
        { apply: true, now, rootDir: '/repo' },
        {
          ...f.deps,
          collection: {
            ...f.deps.collection,
            executePipeline: async () => {
              throw new Error('source unavailable');
            },
          },
        }
      )
    ).rejects.toThrow('source unavailable');
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it('passes the completion clock to downstream freshness checks', async () => {
    const f = fixture(),
      observed = new Date(now.getTime() + 10000),
      completed = new Date(now.getTime() + 20000);
    const changed = {
      ...config,
      sources: [
        {
          source_id: 'org',
          kind: 'pipeline' as const,
          pipeline_ref: 'pipelines/collector.json',
          path: 'active/shared/runtime/public/shared/metrics.json',
          max_age_seconds: 60,
        },
      ],
    };
    const report = await runContinuousOperationsCycle(
      changed,
      { apply: true, now, rootDir: '/repo' },
      {
        ...f.deps,
        clock: () => completed,
        collection: {
          ...f.deps.collection,
          executePipeline: async () => undefined,
          read: () => [
            {
              metric: 'open_incidents',
              value: 1,
              observed_at: observed.toISOString(),
              evidence_ref: 'source:latest',
            },
          ],
        },
      }
    );
    expect(report.inventory[0].current_value).toBe(1);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('does not collect or admit for a disabled loop', async () => {
    const f = fixture(),
      metrics = vi.fn(() => {
        throw new Error('must not collect');
      });
    const result = await runContinuousOperationsCycle(
      { ...config, enabled: false },
      { apply: true, now, rootDir: '/repo' },
      { ...f.deps, collection: { ...f.deps.collection, metrics } }
    );
    expect(result.inventory).toEqual([]);
    expect(metrics).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('rejects a missing charter before any collection', async () => {
    const f = fixture(),
      metrics = vi.fn(() => ({ open_incidents: 1 }));
    await expect(
      runContinuousOperationsCycle(
        config,
        { apply: true, now },
        { ...f.deps, charter: () => undefined, collection: { ...f.deps.collection, metrics } }
      )
    ).rejects.toThrow('charter not found');
    expect(metrics).not.toHaveBeenCalled();
  });
});
