import { describe, expect, it, vi } from 'vitest';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import type { WorkItem, WorkLease } from '@agent/core/workforce/work-coordination-types';
import type { ContinuousOperationsConfig } from '@agent/core/organization/continuous-operations-policy';
import type { WriteScopedArtifactInput } from '@agent/core/workforce/artifact-store';
import {
  runContinuousOperationsReport,
  CONTINUOUS_OPERATIONS_REPORT_PIPELINE,
  type ContinuousOperationsReportDeps,
} from './continuous_operations_report.js';
const now = new Date('2026-10-18T01:00:00.000Z');
const context = {
  dot_id: 'operator',
  work_item_id: 'WITEM-REPORT',
  attempt_id: 'attempt-1',
  lease_id: 'lease-1',
};
function fixture() {
  const scope = {
    tier: 'confidential' as const,
    tenant_slug: 'acme',
    organization_id: 'org',
    project_id: 'PRJ-OPS',
  };
  const config = {
    version: '1',
    loop_id: 'org-ops',
    dot_id: 'operator',
    enabled: true,
    scope,
    sources: [{ source_id: 'metrics', kind: 'organization_metrics', max_age_seconds: 60 }],
    rules: [
      {
        rule_id: 'incidents',
        source_id: 'metrics',
        metric: 'open_incidents',
        operator: 'gt',
        threshold: 0,
        title: 'Inspect reliability',
        objective_ref: 'reliability',
        objective: 'Resolve incidents',
        pipeline_ref: CONTINUOUS_OPERATIONS_REPORT_PIPELINE,
      },
    ],
    max_proposals_per_run: 2,
    cooldown_seconds: 60,
  } as ContinuousOperationsConfig;
  const charter = {
    dot_id: 'operator',
    status: 'active',
    scope,
    authority: {
      authority_role: 'organization_operator',
      allowed_work_shapes: ['pipeline'],
      allowed_pipelines: [CONTINUOUS_OPERATIONS_REPORT_PIPELINE],
    },
  } as DotCharter;
  const item = {
    item_id: context.work_item_id,
    status: 'in_progress',
    lease_id: context.lease_id,
    current_attempt_id: context.attempt_id,
    claimed_by_peer_id: 'dot:operator',
    context: { tenant_slug: 'acme', organization_id: 'org', project_id: 'PRJ-OPS' },
    metadata: {
      dot_id: 'operator',
      authority_role: 'organization_operator',
      pipeline_ref: CONTINUOUS_OPERATIONS_REPORT_PIPELINE,
      requested_work_shape: 'pipeline',
    },
  } as unknown as WorkItem;
  const lease = {
    lease_id: context.lease_id,
    item_id: context.work_item_id,
    holder_peer_id: 'dot:operator',
    status: 'active',
    expires_at: '2026-10-18T02:00:00Z',
  } as WorkLease;
  const collect = vi.fn(async () => [
    {
      source_id: 'metrics',
      observations: [
        {
          metric: 'open_incidents',
          value: 2,
          observed_at: now.toISOString(),
          evidence_ref: 'organization:org/metrics/open_incidents',
        },
      ],
    },
  ]);
  const writeArtifact = vi.fn((_input: WriteScopedArtifactInput) => ({
    absolute_path: '/repo/report.md',
    repo_relative_path: 'active/organizations/confidential/acme/org/artifacts/report.md',
    index_path: '/repo/index.jsonl',
    scope_kind: 'project' as const,
    artifact_id: 'ART-REPORT',
  }));
  const deps: ContinuousOperationsReportDeps = {
    rootDir: '/repo',
    now: () => now,
    loadConfig: () => config,
    charters: () => [charter],
    authorize: () => undefined,
    getItem: () => item,
    leases: () => [lease],
    collect,
    writeArtifact,
  };
  return {
    config,
    charter,
    item,
    lease,
    collect,
    writeArtifact,
    deps,
    run: (ctx = context) =>
      runContinuousOperationsReport(
        'knowledge/product/governance/continuous-operations/organization-operations.json',
        ctx,
        deps
      ),
  };
}
describe('continuous organization report task', () => {
  it('publishes only scoped aggregate counts and objective evidence through the artifact facade', async () => {
    const f = fixture();
    const result = await f.run();
    expect(f.collect).toHaveBeenCalledWith(
      f.config,
      expect.objectContaining({ apply: false, charter: f.charter, rootDir: '/repo' })
    );
    expect(f.writeArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { tenant: 'acme', organization: 'org', project: 'PRJ-OPS' },
        tier: 'confidential',
        artifact_class: 'report',
        publish: expect.objectContaining({ kind: 'report', organization_id: 'org' }),
      })
    );
    const written = f.writeArtifact.mock.calls[0]![0] as { content: string; name: string };
    expect(written.content).toContain('open_incidents | 2');
    expect(written.content).toContain('organization:org/metrics/open_incidents');
    expect(written.content).toContain('Inspect reliability (reliability)');
    expect(written.name).toMatch(/^continuous-operations\/reports\/[a-f0-9]{32}\.md$/);
    expect(result.artifact_ref).toBe('ART-REPORT');
    expect(result.observation_count).toBe(1);
  });
  it('uses the real authority gate before collection when no authority seam is supplied', async () => {
    const f = fixture();
    delete f.deps.authorize;
    await expect(f.run()).rejects.toThrow();
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.writeArtifact).not.toHaveBeenCalled();
  });
  it('rejects caller identity, claim, attempt and tenant mismatches before collection', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.item.claimed_by_peer_id = 'dot:other';
      },
      (f: ReturnType<typeof fixture>) => {
        f.item.current_attempt_id = 'other-attempt';
      },
      (f: ReturnType<typeof fixture>) => {
        f.item.context!.tenant_slug = 'other';
      },
      (f: ReturnType<typeof fixture>) => {
        f.lease.holder_peer_id = 'dot:other';
      },
      (f: ReturnType<typeof fixture>) => {
        f.lease.expires_at = now.toISOString();
      },
    ]) {
      const f = fixture();
      mutate(f);
      await expect(f.run()).rejects.toThrow();
      expect(f.collect).not.toHaveBeenCalled();
      expect(f.writeArtifact).not.toHaveBeenCalled();
    }
    const f = fixture();
    await expect(f.run({ ...context, dot_id: 'other' })).rejects.toThrow('identity');
    expect(f.collect).not.toHaveBeenCalled();
  });
  it('revalidates ownership after collection and refuses publication after lease loss', async () => {
    const f = fixture();
    f.collect.mockImplementation(async () => {
      f.lease.status = 'expired';
      return [];
    });
    await expect(f.run()).rejects.toThrow('lease');
    expect(f.writeArtifact).not.toHaveBeenCalled();
  });
  it('rejects side-effecting collectors, snapshots and missing pipeline authorization', async () => {
    for (const kind of ['pipeline', 'snapshot']) {
      const f = fixture();
      f.config.sources = [
        {
          source_id: 'bad',
          kind,
          max_age_seconds: 60,
          path: 'arbitrary.json',
          pipeline_ref: 'pipelines/other.json',
        },
      ] as ContinuousOperationsConfig['sources'];
      await expect(f.run()).rejects.toThrow('organization_metrics');
      expect(f.collect).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.charter.authority.allowed_pipelines = [];
    await expect(f.run()).rejects.toThrow('not permitted');
    expect(f.collect).not.toHaveBeenCalled();
  });
});
