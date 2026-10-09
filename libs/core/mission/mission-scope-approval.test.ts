import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../customer-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../customer-resolver.js')>();
  const { customerRootWithSodOverlay } =
    await import('../governance/__tests__/sod-overlay-state.js');
  return { ...actual, customerRoot: customerRootWithSodOverlay(actual.customerRoot) };
});
import {
  clearSeparationOfDuties,
  setSeparationOfDuties,
} from '../governance/__tests__/sod-overlay.js';

import * as pathResolver from '../path-resolver.js';
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  decideApprovalRequest,
} from '../governance/approval-store.js';
import {
  createMissionScopeApprovalRequest,
  MISSION_SCOPE_APPROVAL_CHANNEL,
  scopeApproveEffectBinding,
} from './mission-scope-approval.js';
import { approveScopeChange, assertScopeChangeApproval } from './mission-maintenance.js';
import { loadState } from './mission-state.js';
import {
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';

const missionId = 'MSN-SCOPE-APPROVAL-TEST';
const missionPath = pathResolver.missionDir(missionId, 'public');
const actorId = 'scope-approval-test-actor';
const humanDecider = 'human-scope-operator';

let previousMissionRole: string | undefined;
let previousPersona: string | undefined;
let previousUser: string | undefined;
let previousSudo: string | undefined;
const approvalIds: string[] = [];

function currentCommit(): string {
  return safeExec('git', ['rev-parse', 'HEAD'], { cwd: pathResolver.rootDir() }).trim();
}

function prepareMission(overrides?: Record<string, unknown>): void {
  safeMkdir(missionPath, { recursive: true });
  safeWriteFile(
    nodePath.join(missionPath, 'mission-state.json'),
    JSON.stringify(
      {
        mission_id: missionId,
        tier: 'public',
        status: 'validating',
        execution_mode: 'local',
        priority: 1,
        assigned_persona: actorId,
        confidence_score: 1,
        intent: {
          goal_summary: 'original mission goal',
          success_condition: 'original success condition',
        },
        context: { intent_drift_gate_failure_count: 1 },
        git: {
          branch: 'test',
          start_commit: currentCommit(),
          latest_commit: currentCommit(),
          checkpoints: [],
        },
        history: [],
        ...overrides,
      },
      null,
      2
    )
  );
}

function approveRequest(request: {
  id: string;
  channel: string;
  storageChannel: string;
  accountability?: { payloadHash?: string; effectBinding?: string };
}): void {
  decideApprovalRequest('mission_controller', {
    channel: request.channel,
    storageChannel: request.storageChannel,
    requestId: request.id,
    decision: 'approved',
    decidedBy: humanDecider,
    decidedByRole: 'sovereign',
    authMethod: 'manual',
    decidedByType: 'human',
    authenticated: true,
    payloadHash: request.accountability?.payloadHash,
    effectBinding: request.accountability?.effectBinding,
  });
}

const noLedgerSync = async () => undefined;

beforeEach(() => {
  previousMissionRole = process.env.MISSION_ROLE;
  previousPersona = process.env.KYBERION_PERSONA;
  previousUser = process.env.USER;
  previousSudo = process.env.KYBERION_SUDO;
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_PERSONA = actorId;
  delete process.env.KYBERION_SUDO;
  safeRmSync(missionPath, { recursive: true, force: true });
});

afterEach(() => {
  process.env.MISSION_ROLE = 'mission_controller';
  for (const approvalId of approvalIds.splice(0)) {
    safeRmSync(approvalRequestLogicalPath(MISSION_SCOPE_APPROVAL_CHANNEL, approvalId), {
      force: true,
    });
  }
  safeRmSync(approvalEventLogicalPath(MISSION_SCOPE_APPROVAL_CHANNEL), { force: true });
  safeRmSync(missionPath, { recursive: true, force: true });
  if (previousMissionRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = previousMissionRole;
  if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
  else process.env.KYBERION_PERSONA = previousPersona;
  if (previousUser === undefined) delete process.env.USER;
  else process.env.USER = previousUser;
  if (previousSudo === undefined) delete process.env.KYBERION_SUDO;
  else process.env.KYBERION_SUDO = previousSudo;
});

describe('mission scope approval requests', () => {
  it('creates a hash-bound mission_gate request showing what is being approved', () => {
    prepareMission();
    const request = createMissionScopeApprovalRequest({
      missionId,
      goalSummary: 'delivered scope goal',
      reason: 'delivered work diverged legitimately',
      requestedBy: actorId,
      currentGoal: 'original mission goal',
    });
    approvalIds.push(request.id);

    expect(request.kind).toBe('mission_gate');
    expect(request.storageChannel).toBe(MISSION_SCOPE_APPROVAL_CHANNEL);
    expect(request.source?.missionId).toBe(missionId);
    expect(request.accountability?.finalDecision).toBe('human_only');
    expect(request.accountability?.effectBinding).toBe(scopeApproveEffectBinding(missionId));
    expect(request.accountability?.payloadHash).toBeTruthy();
    expect(request.workflow?.approvals[0]?.role).toBe('sovereign');
    // The human must see what they approve: current goal, proposed goal, reason.
    expect(request.details).toContain('original mission goal');
    expect(request.details).toContain('delivered scope goal');
    expect(request.details).toContain('delivered work diverged legitimately');
    expect(request.details).toContain(missionId);
  });

  it('re-request opens a new request instead of reusing a self-approval that separation of duties makes unusable', () => {
    prepareMission();
    const input = {
      missionId,
      goalSummary: 'delivered scope goal',
      reason: 'sod reason',
      requestedBy: humanDecider,
    };
    try {
      setSeparationOfDuties(false);
      const first = createMissionScopeApprovalRequest(input);
      approvalIds.push(first.id);
      approveRequest(first);
      expect(createMissionScopeApprovalRequest(input).id).toBe(first.id);
      setSeparationOfDuties(true);
      const second = createMissionScopeApprovalRequest(input);
      approvalIds.push(second.id);
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe('pending');
    } finally {
      clearSeparationOfDuties();
    }
  });

  it('dedupes an identical pending request instead of filing a second one', () => {
    prepareMission();
    const first = createMissionScopeApprovalRequest({
      missionId,
      goalSummary: 'delivered scope goal',
      reason: 'same reason',
      requestedBy: actorId,
    });
    approvalIds.push(first.id);
    const second = createMissionScopeApprovalRequest({
      missionId,
      goalSummary: 'delivered scope goal',
      reason: 'same reason',
      requestedBy: actorId,
    });
    expect(second.id).toBe(first.id);
  });

  it('rejects apply while the request is still pending', () => {
    prepareMission();
    const request = createMissionScopeApprovalRequest({
      missionId,
      goalSummary: 'delivered scope goal',
      reason: 'pending decision',
      requestedBy: actorId,
    });
    approvalIds.push(request.id);

    expect(() =>
      assertScopeChangeApproval({
        approvalRequestId: request.id,
        missionId,
        goalSummary: 'delivered scope goal',
        reason: 'pending decision',
        successCondition: 'delivered scope goal',
      })
    ).toThrow(/mission_gate/);
  });

  it('rejects apply when the goal differs from what was approved', () => {
    prepareMission();
    const request = createMissionScopeApprovalRequest({
      missionId,
      goalSummary: 'delivered scope goal',
      reason: 'bound reason',
      requestedBy: actorId,
    });
    approvalIds.push(request.id);
    approveRequest(request);

    expect(() =>
      assertScopeChangeApproval({
        approvalRequestId: request.id,
        missionId,
        goalSummary: 'a different goal',
        reason: 'bound reason',
        successCondition: 'a different goal',
      })
    ).toThrow(/different goal\/reason\/success-condition/);
  });

  it('rejects apply bound to a different mission', () => {
    prepareMission();
    const request = createMissionScopeApprovalRequest({
      missionId,
      goalSummary: 'delivered scope goal',
      reason: 'bound reason',
      requestedBy: actorId,
    });
    approvalIds.push(request.id);
    approveRequest(request);

    expect(() =>
      assertScopeChangeApproval({
        approvalRequestId: request.id,
        missionId: 'MSN-OTHER-MISSION',
        goalSummary: 'delivered scope goal',
        reason: 'bound reason',
        successCondition: 'delivered scope goal',
      })
    ).toThrow(/different mission/);
  });
});

describe('approveScopeChange approval path', () => {
  it('applies a rebaseline via approvalRequestId without SUDO and records the human decider', async () => {
    prepareMission();
    const request = createMissionScopeApprovalRequest({
      missionId,
      goalSummary: 'delivered scope goal',
      reason: 'delivered work diverged legitimately',
      requestedBy: actorId,
    });
    approvalIds.push(request.id);
    approveRequest(request);

    await approveScopeChange({
      missionId,
      reason: 'delivered work diverged legitimately',
      goalSummary: 'delivered scope goal',
      approvalRequestId: request.id,
      syncProjectLedgerIfLinked: noLedgerSync,
    });

    const state = loadState(missionId);
    expect(state?.intent?.goal_summary).toBe('delivered scope goal');
    expect(state?.context?.approved_scope_change?.approved_by).toBe(humanDecider);
    expect(
      state?.history?.some((entry: { event?: string }) => entry.event === 'SCOPE_APPROVED')
    ).toBe(true);
  });

  it('closes the repair-intent-drift task so the finish exit gate can pass', async () => {
    prepareMission();
    safeWriteFile(
      nodePath.join(missionPath, 'NEXT_TASKS.json'),
      JSON.stringify(
        [
          {
            task_id: 'repair-intent-drift',
            status: 'planned',
            description: 'Repair mission intent-drift gate failure: drift detected',
            deliverable: 'evidence/repair-intent-drift.md',
          },
        ],
        null,
        2
      )
    );
    const request = createMissionScopeApprovalRequest({
      missionId,
      goalSummary: 'delivered scope goal',
      reason: 'delivered work diverged legitimately',
      requestedBy: actorId,
    });
    approvalIds.push(request.id);
    approveRequest(request);

    await approveScopeChange({
      missionId,
      reason: 'delivered work diverged legitimately',
      goalSummary: 'delivered scope goal',
      approvalRequestId: request.id,
      syncProjectLedgerIfLinked: noLedgerSync,
    });

    const tasks = JSON.parse(
      String(safeReadFile(nodePath.join(missionPath, 'NEXT_TASKS.json')))
    ) as Array<{ task_id?: string; status?: string }>;
    expect(tasks.find((t) => t.task_id === 'repair-intent-drift')?.status).toBe('completed');
    expect(safeExistsSync(nodePath.join(missionPath, 'evidence', 'repair-intent-drift.md'))).toBe(
      true
    );
  });

  it('still requires SUDO on the direct path without an approval request', async () => {
    prepareMission();
    await expect(
      approveScopeChange({
        missionId,
        reason: 'no approval attached',
        goalSummary: 'delivered scope goal',
        syncProjectLedgerIfLinked: noLedgerSync,
      })
    ).rejects.toThrow(/Sudo authority/);
  });
});
