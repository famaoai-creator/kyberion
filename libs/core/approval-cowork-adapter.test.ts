/**
 * Tests for approval-cowork-adapter.ts (Phase 2)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── vi.hoisted ────────────────────────────────────────────────────────────────
const {
  mockListApprovalRequests,
  mockDecideApprovalRequest,
  mockAuditRecord,
} = vi.hoisted(() => ({
  mockListApprovalRequests: vi.fn(),
  mockDecideApprovalRequest: vi.fn(),
  mockAuditRecord: vi.fn().mockReturnValue({ id: 'AUD-TEST' }),
}));

vi.mock('./approval-store.js', () => ({
  listApprovalRequests: mockListApprovalRequests,
  loadApprovalRequest: vi.fn(),
  decideApprovalRequest: mockDecideApprovalRequest,
  createApprovalRequest: vi.fn(),
}));

vi.mock('./audit-chain.js', () => ({
  auditChain: { record: mockAuditRecord },
}));

import {
  listPendingApprovalsForCowork,
  decideApprovalFromCowork,
  recordAuditExportRequest,
} from './approval-cowork-adapter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePendingRecord(overrides: Partial<any> = {}): any {
  return {
    id: 'req-uuid-001',
    kind: 'channel-approval',
    storageChannel: 'cowork',
    channel: 'cowork',
    threadTs: 'ts-001',
    correlationId: 'corr-001',
    requestedBy: 'agent-x',
    requestedAt: '2026-06-22T10:00:00Z',
    status: 'pending',
    title: 'Deploy to production',
    summary: 'Requesting deploy approval',
    severity: 'high',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('listPendingApprovalsForCowork()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pending リクエストを CoworkPendingApproval 形式で返す', () => {
    const record = makePendingRecord();
    mockListApprovalRequests.mockReturnValue([record]);

    const result = listPendingApprovalsForCowork();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      request_id: 'req-uuid-001',
      title: 'Deploy to production',
      severity: 'high',
      requested_by: 'agent-x',
      channel: 'cowork',
      storage_channel: 'cowork',
    });
  });

  it('pending がない場合は空配列を返す', () => {
    mockListApprovalRequests.mockReturnValue([]);
    expect(listPendingApprovalsForCowork()).toEqual([]);
  });

  it('監査エントリを記録する', () => {
    mockListApprovalRequests.mockReturnValue([makePendingRecord()]);
    listPendingApprovalsForCowork();

    expect(mockAuditRecord).toHaveBeenCalledOnce();
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cowork.approval.list_pending', result: 'completed' }),
    );
  });

  it('status: pending でフィルタして呼び出す', () => {
    mockListApprovalRequests.mockReturnValue([]);
    listPendingApprovalsForCowork();
    expect(mockListApprovalRequests).toHaveBeenCalledWith({ status: 'pending' });
  });
});

describe('decideApprovalFromCowork()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('valid な requestId で承認を適用し結果を返す', () => {
    const record = makePendingRecord();
    mockListApprovalRequests.mockReturnValue([record]);
    mockDecideApprovalRequest.mockReturnValue({
      ...record,
      status: 'approved',
      decidedAt: '2026-06-22T11:00:00Z',
      decidedBy: 'operator-1',
    });

    const result = decideApprovalFromCowork({
      requestId: 'req-uuid-001',
      decision: 'approved',
      decidedBy: 'operator-1',
      note: 'LGTM',
    });

    expect(result.decision).toBe('approved');
    expect(result.decided_by).toBe('operator-1');
    expect(result.previous_status).toBe('pending');
    expect(mockDecideApprovalRequest).toHaveBeenCalledOnce();
  });

  it('requestId が pending 一覧にない場合はエラーをスロー', () => {
    mockListApprovalRequests.mockReturnValue([]); // empty — request not found

    expect(() =>
      decideApprovalFromCowork({
        requestId: 'nonexistent-id',
        decision: 'approved',
        decidedBy: 'operator-1',
      }),
    ).toThrow('[APPROVAL_ERROR]');
  });

  it('リクエスト未発見時に denied 監査エントリを記録する', () => {
    mockListApprovalRequests.mockReturnValue([]);
    try {
      decideApprovalFromCowork({ requestId: 'bad-id', decision: 'approved', decidedBy: 'op' });
    } catch {}

    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'denied', action: 'cowork.approval.decide' }),
    );
  });

  it('成功時に completed 監査エントリを記録する', () => {
    const record = makePendingRecord();
    mockListApprovalRequests.mockReturnValue([record]);
    mockDecideApprovalRequest.mockReturnValue({ ...record, status: 'rejected', decidedAt: '2026-06-22T11:00:00Z' });

    decideApprovalFromCowork({ requestId: 'req-uuid-001', decision: 'rejected', decidedBy: 'op' });

    expect(mockAuditRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({ result: 'completed', action: 'cowork.approval.decide' }),
    );
  });

  it('decision が approved/rejected 以外はアダプタ自体では弾かない（zod バリデーションは MCP 層）', () => {
    const record = makePendingRecord();
    mockListApprovalRequests.mockReturnValue([record]);
    mockDecideApprovalRequest.mockReturnValue({ ...record, status: 'approved', decidedAt: '2026-06-22T11:00:00Z' });

    // Calling with a valid decision still works
    expect(() =>
      decideApprovalFromCowork({ requestId: 'req-uuid-001', decision: 'approved', decidedBy: 'op' }),
    ).not.toThrow();
  });
});

describe('recordAuditExportRequest()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('verify_only=true のとき監査エントリを記録する', () => {
    recordAuditExportRequest({ requestedBy: 'op', verifyOnly: true });
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cowork.audit.export', metadata: expect.objectContaining({ verify_only: true }) }),
    );
  });

  it('from/to/missionId がメタデータに含まれる', () => {
    recordAuditExportRequest({ requestedBy: 'op', from: '2026-06-01', to: '2026-06-22', missionId: 'M1', verifyOnly: false });
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ from: '2026-06-01', to: '2026-06-22', mission_id: 'M1' }),
      }),
    );
  });
});
