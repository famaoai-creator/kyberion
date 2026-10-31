import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R13: the home screen's approval numbers must come from one snapshot and
 * one bucket definition. Reproduces the observed '承認8件' (sliced display
 * list) vs '承認待ち13件' (full pending list) discrepancy: buckets are now
 * 'visible pending total' (same denominator as `pnpm kyberion approvals`),
 * the 'actionable' top-N actually rendered, and 'other kinds' the summary
 * cannot attribute.
 */

const mocks = vi.hoisted(() => ({
  listApprovalRequests: vi.fn(),
  collectDoctorReport: vi.fn(),
  getGovernanceControlSummary: vi.fn(),
  collectOperatorHomeSummary: vi.fn(),
}));

vi.mock('@agent/core/governance/approval-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance/approval-store')>()),
  listApprovalRequests: mocks.listApprovalRequests,
}));

vi.mock('./run_doctor.js', () => ({
  collectDoctorReport: mocks.collectDoctorReport,
}));

vi.mock('@agent/core/governance/governance-status', () => ({
  getGovernanceControlSummary: mocks.getGovernanceControlSummary,
}));

vi.mock('@agent/core/surface/operator-home-summary', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/surface/operator-home-summary')>()),
  collectOperatorHomeSummary: mocks.collectOperatorHomeSummary,
}));

const pendingApproval = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  status: 'pending',
  severity: 'normal',
  ...extra,
});

describe('operator home approval buckets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The view-layer tests mock collectOperatorHomeSummary; the bucket tests
  // exercise the real implementation (its approval-store import stays mocked).
  const realCollectOperatorHomeSummary = async () =>
    (
      await vi.importActual<typeof import('@agent/core/surface/operator-home-summary')>(
        '@agent/core/surface/operator-home-summary'
      )
    ).collectOperatorHomeSummary;

  it('reports the visible pending total, not the sliced actionable list', async () => {
    // 13 pending + display limit 8 — the input set behind '8 vs 13'.
    mocks.listApprovalRequests.mockReturnValue(
      Array.from({ length: 13 }, (_, index) => pendingApproval(`APR-${index + 1}`))
    );
    const collect = await realCollectOperatorHomeSummary();
    const summary = collect({ limit: 8 });

    expect(mocks.listApprovalRequests).toHaveBeenCalledTimes(1);
    expect(mocks.listApprovalRequests).toHaveBeenCalledWith({ status: 'pending' });
    expect(summary.counts.pendingApprovals).toBe(13);
    expect(summary.counts.pendingApprovalsShown).toBe(8);
    expect(summary.pendingApprovals).toHaveLength(8);
    expect(summary.counts.pendingApprovalsOther).toBeUndefined();
  });

  it('labels other approval kinds with their own denominator', async () => {
    mocks.listApprovalRequests.mockReturnValue([
      ...Array.from({ length: 3 }, (_, index) => pendingApproval(`APR-${index + 1}`)),
      // Scoped-learning approval whose candidate cannot be resolved: not an
      // operator-actionable item and never displayed as one, but it exists
      // in the same visible store — counted under its own bucket.
      pendingApproval('APR-SCOPED-LEARNING', {
        accountability: { effectBinding: 'scoped-learning:mem-1' },
        scope: { tier: 'confidential', tenant_slug: 'tenant-a' },
        source: { taskId: 'candidate-1' },
      }),
    ]);
    const collect = await realCollectOperatorHomeSummary();
    const summary = collect({ limit: 8 });

    expect(summary.counts.pendingApprovals).toBe(3);
    expect(summary.counts.pendingApprovalsOther).toBe(1);
    expect(summary.pendingApprovals.map((row) => row.id)).not.toContain('APR-SCOPED-LEARNING');
  });

  it('never emits the unattributed bucket under a scope filter', async () => {
    mocks.listApprovalRequests.mockReturnValue([
      pendingApproval('APR-VISIBLE', { scope: { tier: 'public', tenant_slug: 'tenant-a' } }),
      pendingApproval('APR-OTHER-TENANT', { scope: { tier: 'public', tenant_slug: 'tenant-b' } }),
    ]);
    const collect = await realCollectOperatorHomeSummary();
    const summary = collect({
      scope: { tiers: ['public'], tenantSlugs: ['tenant-a'] },
    });

    expect(summary.counts.pendingApprovals).toBe(1);
    // A scoped view must not leak how many hidden items exist.
    expect(summary.counts.pendingApprovalsOther).toBeUndefined();
  });
});

describe('home view approval count', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.collectDoctorReport.mockResolvedValue({ totalMissing: 0 });
    mocks.getGovernanceControlSummary.mockReturnValue({ pending_approvals: 999 });
    mocks.collectOperatorHomeSummary.mockReturnValue({
      generatedAt: '2026-10-31T00:00:00Z',
      status: 'attention',
      statusLabel: 'attention',
      statusDetail: 'detail',
      counts: {
        activeMissions: 0,
        recentlyActiveMissions: 0,
        blockedMissions: 0,
        pendingApprovals: 13,
        pendingApprovalsShown: 8,
        clarificationQuestions: 0,
        unreadInbox: 0,
        totalInbox: 0,
        pendingQualityDecisions: 0,
      },
      activeMissions: [],
      pendingApprovals: [],
      inboxEntries: [],
      costSummary: {},
      nextAction: { title: 'review approvals', next_action_type: 'run_command' },
    });
  });

  it('renders the home snapshot count, not a second wider ledger read', async () => {
    const { showHome } = await import('./operator-home-view.js');
    const lines: string[] = [];
    await showHome(
      (key, params) => `${key} ${JSON.stringify(params ?? {})}`,
      false,
      (value) => lines.push(String(value))
    );

    const countsLine = lines.find((line) => line.includes('recorder_home_counts'));
    expect(countsLine).toBeDefined();
    expect(countsLine).toContain('13');
    expect(countsLine).not.toContain('999');
  });
});
