import { describe, expect, it, vi } from 'vitest';
import type { DotCharter } from '../dot/dot-charter.js';
import { collectContinuousOperationsSources } from './continuous-operations-sources.js';

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
