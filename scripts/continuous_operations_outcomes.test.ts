import { describe, it, expect, vi } from 'vitest';
import { observeContinuousWork } from './continuous_operations_outcomes.js';
import type { ContinuousOutcomeDeps } from './continuous_operations_outcomes.js';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import type { ContinuousOperationsReport } from '@agent/core/organization/continuous-operations';
const scope = { tier: 'confidential', tenant_slug: 'acme', organization_id: 'org' };
const charter = { dot_id: 'ops', scope } as DotCharter;
const report = { inventory: [{ rule_id: 'r', action_ref: 'a' }] } as ContinuousOperationsReport;
function fixture(managed = false) {
  const item = {
    item_id: 'w',
    context: { tenant_slug: 'acme', organization_id: 'org' },
    status: 'in_progress',
    metadata: managed ? { continuous_work: {} } : {},
  };
  const record = {
    artifact_id: 'owned',
    tenant_slug: 'acme',
    organization_id: 'org',
    evidence_refs: ['report:owned'],
    metadata: { tier: 'confidential', work_item_id: 'w' },
  };
  const progress = vi.fn(() => ({
    work_item_id: 'w',
    project_id: 'p',
    status: 'running',
    missions: {
      m: {
        mission_id: 'MSN-CHILD',
        status: 'pending_approval',
        approval_request_id: 'approval-child',
      },
    },
  }));
  const deps = {
    actions: () => [
      {
        dot_id: 'ops',
        action_ref: 'a',
        status: 'dispatched',
        work_item_id: 'w',
        request_id: 'approval-parent',
      },
    ],
    results: () => [{ action_ref: 'a', work_item_id: 'w', status: 'done', completed_at: 'time' }],
    item: () => item,
    artifacts: () => [
      record,
      { ...record, artifact_id: 'other-tenant', tenant_slug: 'other' },
      { ...record, artifact_id: 'other-project', project_id: 'other' },
      { ...record, artifact_id: 'other-tier', metadata: { ...record.metadata, tier: 'personal' } },
      {
        ...record,
        artifact_id: 'other-item',
        metadata: { ...record.metadata, work_item_id: 'different' },
      },
    ],
    progress,
  } as unknown as ContinuousOutcomeDeps;
  return { deps, item, progress };
}
describe('continuous operations feedback', () => {
  it('joins managed artifacts only through proven project and created mission identities', () => {
    const f = fixture(true);
    f.progress.mockReturnValue({
      work_item_id: 'w',
      project_id: 'p',
      status: 'running',
      missions: {
        m: {
          mission_id: 'MSN-CHILD',
          created: true,
          status: 'pending_approval',
          approval_request_id: 'approval-child',
        },
      },
    } as never);
    const row = {
      artifact_id: 'managed',
      tenant_slug: 'acme',
      organization_id: 'org',
      project_id: 'p',
      mission_id: 'MSN-CHILD',
      evidence_refs: ['mission:MSN-CHILD'],
      metadata: { tier: 'confidential' },
    };
    const artifacts = vi.fn(() => [
      row,
      { ...row, artifact_id: 'unrelated-mission', mission_id: 'MSN-OTHER' },
      { ...row, artifact_id: 'unrelated-project', project_id: 'other' },
      { ...row, artifact_id: 'unrelated-tenant', tenant_slug: 'other' },
      { ...row, artifact_id: 'unrelated-tier', metadata: { tier: 'personal' } },
    ]);
    f.deps.artifacts = artifacts as unknown as ContinuousOutcomeDeps['artifacts'];
    expect(observeContinuousWork(charter, report, '/repo', f.deps)[0]?.artifact_refs).toEqual([
      { artifact_id: 'managed', evidence_refs: ['mission:MSN-CHILD'] },
    ]);
    expect(artifacts).toHaveBeenLastCalledWith({
      tenantSlug: 'acme',
      organizationId: 'org',
      projectId: 'p',
    });
  });

  it('returns only exact scoped artifacts linked to the actual work item', () => {
    const f = fixture();
    expect(observeContinuousWork(charter, report, '/repo', f.deps)).toEqual([
      expect.objectContaining({
        approval_request_id: 'approval-parent',
        work_item_id: 'w',
        execution_status: 'done',
        artifact_refs: [{ artifact_id: 'owned', evidence_refs: ['report:owned'] }],
      }),
    ]);
    expect(f.progress).not.toHaveBeenCalled();
  });
  it('recovers actual managed project and mission progress without advancing it', () => {
    const f = fixture(true);
    const row = observeContinuousWork(charter, report, '/repo', f.deps)[0];
    expect(row?.managed_work).toMatchObject({
      project_id: 'p',
      status: 'running',
      missions: { m: { mission_id: 'MSN-CHILD', approval_request_id: 'approval-child' } },
    });
    expect(f.progress).toHaveBeenCalledWith(charter, f.item, { rootDir: '/repo' });
  });
  it('rejects a cross-tenant work item even if action IDs match', () => {
    const f = fixture();
    f.item.context.tenant_slug = 'other';
    expect(() => observeContinuousWork(charter, report, '/repo', f.deps)).toThrow('scope mismatch');
    expect(f.progress).not.toHaveBeenCalled();
  });
  it('does not attribute result evidence from another work item', () => {
    const f = fixture();
    f.deps.results = (() => [
      { action_ref: 'a', work_item_id: 'unrelated', status: 'done' },
    ]) as unknown as ContinuousOutcomeDeps['results'];
    expect(
      observeContinuousWork(charter, report, '/repo', f.deps)[0]?.execution_status
    ).toBeUndefined();
  });
});
