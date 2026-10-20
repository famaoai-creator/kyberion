import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryCandidate } from '../knowledge/memory-promotion-queue.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import type { OperatorHomeScopeFilter } from './operator-home-summary.js';

const state = vi.hoisted(() => ({
  candidates: [] as MemoryCandidate[],
  approvals: [] as ApprovalRequestRecord[],
  unavailable: false,
  approvalReads: vi.fn(),
}));
vi.mock('../knowledge/memory-promotion-queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../knowledge/memory-promotion-queue.js')>()),
  listMemoryPromotionCandidates: () => {
    if (state.unavailable) throw new Error('synthetic unavailable candidate store');
    return state.candidates;
  },
}));
vi.mock('../governance/approval-store.js', () => ({
  listApprovalRequests: (...args: unknown[]) => {
    state.approvalReads(...args);
    return state.approvals;
  },
}));
// Unrelated stores are intentionally absent. No fixtures or raw filesystem IO.
vi.mock('../metrics.js', () => ({
  MetricsCollector: class {
    loadHistory() {
      return [];
    }
  },
  metricsWithheldNotice: () => undefined,
}));
vi.mock('../workforce/artifact-record.js', () => ({ listArtifactRecords: () => [] }));
vi.mock('../deliverable-inbox.js', () => ({ listInboxEntries: () => [] }));
vi.mock('../mission/mission-management-config.js', () => ({
  loadMissionManagementConfig: () => ({ directories: {} }),
}));
vi.mock('../mission/mission-state-reader.js', () => ({ loadMissionStateAtPath: () => null }));
vi.mock('../mission/mission-team-binding.js', () => ({
  loadMissionStaffingAssignments: () => null,
}));
vi.mock('../software-quality-report-reader.js', () => ({
  loadSoftwareQualityReportAtPath: () => null,
}));
vi.mock('../nhi-lifecycle-governance.js', () => ({
  buildNhiLedgerReport: () => ({ total: 0, orphans: [], by_status: {} }),
}));
vi.mock('../next-action.js', () => ({ buildNextAction: (input: unknown) => input }));
vi.mock('../t.js', () => ({ t: (key: string) => key }));
vi.mock('../secure-io.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../secure-io.js')>()),
  safeExistsSync: () => false,
  safeReaddir: () => [],
  assertSafeRepositoryPath: (file: string) => file,
}));

import { scopedLearningApprovalBinding } from '../knowledge/scoped-learning-approval-verifier.js';
import { collectOperatorHomeSummary } from './operator-home-summary.js';

const exactScope = {
  tier: 'confidential' as const,
  tenant_slug: 'home-learning',
  organization_id: 'org-selected',
  project_id: 'project-selected',
};
const viewer: OperatorHomeScopeFilter = {
  tiers: ['confidential'],
  tenantSlugs: ['home-learning'],
  organizationIds: ['org-selected'],
  projectIds: ['project-selected'],
};
function candidate(id = 'MEM-HOME-EXACT', scope = exactScope): MemoryCandidate {
  return {
    candidate_id: id,
    source_type: 'task_session',
    source_ref: 'task_session:' + id,
    knowledge_domain: 'organization',
    proposed_memory_kind: 'sop',
    summary: 'Reconcile the selected project source records before publishing its report.',
    evidence_refs: ['task_session:' + id],
    sensitivity_tier: 'confidential',
    ratification_required: true,
    status: 'queued',
    queued_at: '2026-10-20T00:00:00.000Z',
    scope,
    curation: {
      title: 'Scoped reconciliation procedure',
      summary: 'Reconcile the selected project source records before publishing its report.',
      content: 'Compare the source totals, investigate discrepancies, and retain the evidence.',
      evidence_refs: ['task_session:' + id],
    },
  };
}
function approval(row: MemoryCandidate): ApprovalRequestRecord {
  const binding = scopedLearningApprovalBinding(row);
  return {
    id: 'APPROVAL-' + row.candidate_id,
    kind: 'mission_gate',
    channel: 'terminal',
    storageChannel: 'terminal',
    threadTs: 'scoped-learning-' + binding.digest,
    correlationId: 'scoped-learning:' + binding.digest,
    requestedBy: 'agent:synthetic-home',
    requestedAt: '2026-10-20T00:00:00.000Z',
    title: 'Review ' + row.candidate_id,
    summary: 'Review the exact scoped procedure.',
    status: 'pending',
    severity: 'medium',
    source: { taskId: row.candidate_id },
    scope: binding.scope,
    accountability: {
      finalDecision: 'human_only',
      payloadHash: binding.digest,
      effectBinding: binding.effect,
    },
    justification: { reason: 'Scoped reusable knowledge', requestedEffects: [binding.effect] },
  };
}
function expectNoApprovalRecommendation(summary: ReturnType<typeof collectOperatorHomeSummary>) {
  expect(summary.pendingApprovals).toEqual([]);
  expect(summary.counts.pendingApprovals).toBe(0);
  expect(summary.actionQueue).toEqual([]);
  expect(summary.status).toBe('ready');
  expect(summary.nextAction.next_action_key).toBe('operator_home:next_action.monitor');
}
beforeEach(() => {
  state.candidates = [];
  state.approvals = [];
  state.unavailable = false;
  state.approvalReads.mockClear();
});

describe('operator home scoped learning approvals', () => {
  it('includes only the exact currently bound candidate and derives its approval action', () => {
    const row = candidate();
    const record = approval(row);
    state.candidates = [row];
    state.approvals = [record];
    const summary = collectOperatorHomeSummary({ scope: viewer });
    expect(summary.pendingApprovals.map((item) => item.id)).toEqual([record.id]);
    expect(summary.counts.pendingApprovals).toBe(1);
    expect(summary.actionQueue).toMatchObject([
      { actionId: 'approval:' + record.id, kind: 'approval' },
    ]);
    expect(summary.nextAction.next_action_key).toBe('operator_home:next_action.review_approvals');
    expect(state.approvalReads).toHaveBeenCalledWith({ status: 'pending' });
  });

  it.each([
    { organization_id: 'org-other' },
    { project_id: 'project-other' },
    { tenant_slug: 'tenant-other' },
  ])('withholds an exact request outside viewer containment: %j', (outside) => {
    const row = candidate('MEM-HOME-OUTSIDE', { ...exactScope, ...outside });
    state.candidates = [row];
    state.approvals = [approval(row)];
    expectNoApprovalRecommendation(collectOperatorHomeSummary({ scope: viewer }));
  });

  it('does not expose confidential approvals through a lower-tier home view', () => {
    const row = candidate();
    state.candidates = [row];
    state.approvals = [approval(row)];
    expectNoApprovalRecommendation(
      collectOperatorHomeSummary({ scope: { ...viewer, tiers: ['public'] } })
    );
  });

  it.each(['deleted', 'changed', 'duplicate', 'malformed', 'unavailable'] as const)(
    'fails closed when the canonical candidate is %s, even without a scope filter',
    (failure) => {
      const row = candidate();
      state.approvals = [approval(row)];
      state.candidates = [row];
      if (failure === 'deleted') state.candidates = [];
      if (failure === 'changed')
        state.candidates = [
          {
            ...row,
            curation: {
              ...row.curation!,
              content: 'Different content must receive its own human review.',
            },
          },
        ];
      if (failure === 'duplicate') state.candidates = [row, { ...row }];
      if (failure === 'malformed')
        state.candidates = [{ ...row, scope: { tier: 'confidential', tenant_slug: '' } }];
      if (failure === 'unavailable') state.unavailable = true;
      expectNoApprovalRecommendation(collectOperatorHomeSummary({ scope: viewer }));
      expectNoApprovalRecommendation(collectOperatorHomeSummary());
    }
  );

  it.each(['binding', 'missing_source', 'missing_scope'] as const)(
    'never falls back to ordinary approval visibility for a %s request',
    (failure) => {
      const row = candidate();
      let record = approval(row);
      if (failure === 'binding')
        record = {
          ...record,
          accountability: { ...record.accountability!, payloadHash: '0'.repeat(64) },
        };
      if (failure === 'missing_source') record = { ...record, source: undefined };
      if (failure === 'missing_scope') record = { ...record, scope: undefined };
      state.candidates = [row];
      state.approvals = [record];
      expectNoApprovalRecommendation(
        collectOperatorHomeSummary({
          scope: { ...viewer, includeUntenanted: true },
        })
      );
      expectNoApprovalRecommendation(collectOperatorHomeSummary());
    }
  );

  it('filters before the limit and derives counts and recommendation only from visible rows', () => {
    const hidden = Array.from({ length: 10 }, (_, index) =>
      candidate('MEM-HIDDEN-' + index, { ...exactScope, project_id: 'project-hidden' })
    );
    const visible = [candidate('MEM-VISIBLE-1'), candidate('MEM-VISIBLE-2')];
    state.candidates = [...hidden, ...visible];
    state.approvals = state.candidates.map(approval);
    const limited = collectOperatorHomeSummary({ scope: viewer, limit: 1 });
    expect(limited.pendingApprovals.map((row) => row.id)).toEqual(['APPROVAL-MEM-VISIBLE-1']);
    expect(limited.counts.pendingApprovals).toBe(1);
    expect(limited.nextAction.next_action_key).toBe('operator_home:next_action.review_approvals');
    expect(limited.actionQueue?.map((row) => row.actionId)).toEqual([
      'approval:APPROVAL-MEM-VISIBLE-1',
    ]);
    expect(JSON.stringify(limited)).not.toContain('MEM-HIDDEN');
    expect(collectOperatorHomeSummary({ scope: viewer }).counts.pendingApprovals).toBe(2);
    state.approvals = hidden.map(approval);
    expectNoApprovalRecommendation(collectOperatorHomeSummary({ scope: viewer, limit: 1 }));
  });
});
