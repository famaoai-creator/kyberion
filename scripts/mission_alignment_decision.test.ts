import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Minimal shape of the fields assessAlignmentDecision reads off a record. */
type FakeApprovalRecord = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  findMissionPath: vi.fn<(id: string) => string | undefined>(),
  listApprovalRequests: vi.fn<(params?: unknown) => Record<string, unknown>[]>(),
  // Deterministic stand-in for the real SHA-256 canonicalizer: all the assessor
  // needs is "same content -> same hash, different content -> different hash".
  computeApprovalPayloadHash: vi.fn((payload: Record<string, unknown> | undefined) =>
    JSON.stringify(payload ?? {})
  ),
  safeExistsSync: vi.fn<(p: string) => boolean>(),
  safeReadFile: vi.fn<(p: string, opts?: unknown) => string>(),
}));

vi.mock('@agent/core', () => ({
  findMissionPath: mocks.findMissionPath,
  listApprovalRequests: mocks.listApprovalRequests,
  computeApprovalPayloadHash: mocks.computeApprovalPayloadHash,
}));

vi.mock('@agent/core/secure-io', () => ({
  safeExistsSync: mocks.safeExistsSync,
  safeReadFile: mocks.safeReadFile,
}));

vi.mock('@agent/core/cli-utils', () => ({
  createStandardYargs: vi.fn(),
}));

const { assessAlignmentDecision } = await import('./mission_alignment_decision.js');

const MISSION_ID = 'MSN-ALIGN-TEST';
const MISSION_DIR = '/tmp/kyberion/active/missions/MSN-ALIGN-TEST';
const BRIEF = { missionId: MISSION_ID, title: 'テスト', victoryConditions: ['a'] };

function briefHash(brief: unknown): string {
  return JSON.stringify(brief);
}

function approvalRecord(overrides: Record<string, unknown> = {}): FakeApprovalRecord {
  return {
    id: 'apr-1',
    kind: 'mission_gate',
    status: 'approved',
    requestedAt: '2026-08-03T00:00:00.000Z',
    decidedAt: '2026-08-03T01:00:00.000Z',
    decidedBy: 'sovereign',
    source: { missionId: MISSION_ID },
    requestedByContext: { surface: 'brief', actorId: 'sovereign', actorRole: 'sovereign' },
    accountability: { finalDecision: 'human_only', payloadHash: briefHash(BRIEF) },
    ...overrides,
  };
}

function briefOnDisk(brief: unknown): void {
  mocks.safeExistsSync.mockReturnValue(true);
  mocks.safeReadFile.mockReturnValue(JSON.stringify(brief));
}

describe('mission_alignment_decision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMissionPath.mockReturnValue(MISSION_DIR);
    mocks.computeApprovalPayloadHash.mockImplementation((payload) => JSON.stringify(payload ?? {}));
    briefOnDisk(BRIEF);
  });

  it('passes when the mission is approved and the brief still matches', () => {
    mocks.listApprovalRequests.mockReturnValue([approvalRecord()]);
    const report = assessAlignmentDecision(MISSION_ID);
    expect(report.verdict).toBe('approved');
    expect(report.satisfied).toBe(true);
    expect(report.surface).toBe('brief');
    expect(report.reasons).toEqual([]);
  });

  it('fails closed when the brief was edited after approval', () => {
    mocks.listApprovalRequests.mockReturnValue([approvalRecord()]);
    briefOnDisk({ ...BRIEF, victoryConditions: ['a', 'sneaked in after approval'] });

    const report = assessAlignmentDecision(MISSION_ID);
    expect(report.verdict).toBe('brief_drifted');
    expect(report.satisfied).toBe(false);
    expect(report.reasons[0]).toMatch(/changed after approval/u);
  });

  it('fails closed when the approval carries no payload binding', () => {
    mocks.listApprovalRequests.mockReturnValue([
      approvalRecord({ accountability: { finalDecision: 'human_only' } }),
    ]);
    const report = assessAlignmentDecision(MISSION_ID);
    expect(report.verdict).toBe('unbound');
    expect(report.satisfied).toBe(false);
  });

  it('reports pending while the Sovereign has not decided', () => {
    mocks.listApprovalRequests.mockReturnValue([
      approvalRecord({ status: 'pending', decidedAt: undefined, decidedBy: undefined }),
    ]);
    const report = assessAlignmentDecision(MISSION_ID);
    expect(report.verdict).toBe('pending');
    expect(report.satisfied).toBe(false);
  });

  it('reports rejection so the changes loop can re-render the brief', () => {
    mocks.listApprovalRequests.mockReturnValue([approvalRecord({ status: 'rejected' })]);
    const report = assessAlignmentDecision(MISSION_ID);
    expect(report.verdict).toBe('rejected');
    expect(report.satisfied).toBe(false);
  });

  it('reports a missing brief rather than passing on the record alone', () => {
    mocks.listApprovalRequests.mockReturnValue([approvalRecord()]);
    mocks.safeExistsSync.mockReturnValue(false);
    const report = assessAlignmentDecision(MISSION_ID);
    expect(report.verdict).toBe('brief_missing');
    expect(report.satisfied).toBe(false);
  });

  it('reports no_request when the mission has no alignment approval yet', () => {
    mocks.listApprovalRequests.mockReturnValue([]);
    const report = assessAlignmentDecision(MISSION_ID);
    expect(report.verdict).toBe('no_request');
    expect(report.satisfied).toBe(false);
  });

  it('ignores approvals belonging to other missions', () => {
    mocks.listApprovalRequests.mockReturnValue([
      approvalRecord({ source: { missionId: 'MSN-SOMETHING-ELSE' } }),
    ]);
    const report = assessAlignmentDecision(MISSION_ID);
    expect(report.verdict).toBe('no_request');
  });

  it('reports no_mission when the mission directory is absent', () => {
    mocks.findMissionPath.mockReturnValue(undefined);
    const report = assessAlignmentDecision(MISSION_ID);
    expect(report.verdict).toBe('no_mission');
    expect(report.satisfied).toBe(false);
  });

  it('uses the newest request so a re-request supersedes an earlier rejection', () => {
    // listApprovalRequests returns newest-first.
    mocks.listApprovalRequests.mockReturnValue([
      approvalRecord({ id: 'apr-2', requestedAt: '2026-08-03T05:00:00.000Z' }),
      approvalRecord({ id: 'apr-1', status: 'rejected' }),
    ]);
    const report = assessAlignmentDecision(MISSION_ID);
    expect(report.requestId).toBe('apr-2');
    expect(report.verdict).toBe('approved');
  });

  it('accepts a lowercase mission id', () => {
    mocks.listApprovalRequests.mockReturnValue([approvalRecord()]);
    const report = assessAlignmentDecision(MISSION_ID.toLowerCase());
    expect(report.missionId).toBe(MISSION_ID);
    expect(report.verdict).toBe('approved');
  });
});
