import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../authn/stance-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../authn/stance-resolver.js')>();
  const { customerRootWithSodOverlay } =
    await import('../governance/__tests__/sod-overlay-state.js');
  return { ...actual, stanceRoot: customerRootWithSodOverlay(actual.stanceRoot) };
});
import { useSeparationOfDutiesOverlay } from '../governance/__tests__/sod-overlay.js';
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  decideApprovalRequest,
} from '../governance/approval-store.js';
import * as pathResolver from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { signHumanOverride } from './mission-gate-engine.js';
import {
  createMissionGateHoldApprovalRequest,
  prepareMissionGateHoldRecord,
  writeMissionGateHoldRecord,
} from './mission-gate-hold-approval.js';
import { MISSION_GATE_HOLD_APPROVAL_CHANNEL } from './mission-gate-hold-payload.js';
import {
  applyMissionGateHoldProof,
  missionGateHoldProof,
  missionGateHoldRecordPath,
  pendingHumanHolds,
  resolveRequiredHumanHolds,
  tasksBehindPendingHumanHolds,
} from './mission-gate-hold-proof.js';
import { evaluateMissionFinishExitGate } from './mission-lifecycle.js';
import { evaluateStoredMissionGate } from './mission-process-planning.js';

const missionId = 'MSN-GATE-HOLD-TEST';
const missionPath = pathResolver.missionDir(missionId, 'public');
const actorId = 'gate-hold-test-agent';
const humanId = 'human-gate-hold-operator';
const SCOPE_GATE = 'REVERSE_SPEC_SCOPE_CONFIRMED';
const GRAPH_GATE = 'CODE_GRAPH_FROZEN';
const approvalIds: string[] = [];
let previousMissionRole: string | undefined;
let previousPersona: string | undefined;

const PHASES = [
  'intake',
  'classification',
  'ingest',
  'code_graph',
  'analysis',
  'delivery',
  'retrospective',
];

function writeJson(relative: string, value: unknown): void {
  const file = nodePath.join(missionPath, relative);
  safeMkdir(nodePath.dirname(file), { recursive: true });
  safeWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function gateDefinition(gateId: string, phase: string, evidence: string) {
  return {
    mission_id: missionId,
    phase,
    position: 'exit',
    gate: {
      id: gateId,
      checks: [
        { kind: 'evidence_exists', params: { path: evidence } },
        // As stored by missions created before the catalog flag: the catalog
        // still makes this a required hold.
        { kind: 'human_override' },
      ],
    },
  };
}

function prepareMission(workflowId = 'reverse-spec-extraction'): void {
  safeMkdir(missionPath, { recursive: true });
  writeJson('mission-state.json', {
    mission_id: missionId,
    tier: 'public',
    status: 'active',
    execution_mode: 'local',
    priority: 1,
    org_role: actorId,
    confidence_score: 1,
    git: { branch: 'test', start_commit: 'start', latest_commit: 'start', checkpoints: [] },
    history: [],
    context: {},
    process_template: { workflow_id: workflowId, phases: PHASES },
  });
  writeJson('evidence/reverse-spec-scope.json', { purpose: 'maintenance' });
  writeJson('evidence/code-graph.json', { nodes: [] });
  writeJson(
    `gates/definitions/${SCOPE_GATE}.json`,
    gateDefinition(SCOPE_GATE, 'ingest', 'evidence/reverse-spec-scope.json')
  );
  writeJson(
    `gates/definitions/${GRAPH_GATE}.json`,
    gateDefinition(GRAPH_GATE, 'code_graph', 'evidence/code-graph.json')
  );
  writeJson('NEXT_TASKS.json', [
    { task_id: 'ingest-scope', phase: 'ingest', status: 'completed', dependencies: [] },
    { task_id: 'code_graph-code-graph', phase: 'code_graph', status: 'planned', dependencies: [] },
    { task_id: 'analysis-analyze', phase: 'analysis', status: 'planned', dependencies: [] },
  ]);
}

function requestAndDecide(
  gateId: string,
  decision: { decidedByType?: 'human' | 'agent'; authenticated?: boolean } = {}
): string {
  const request = createMissionGateHoldApprovalRequest({
    missionId,
    gateId,
    requestedBy: actorId,
  });
  approvalIds.push(request.id);
  decideApprovalRequest('mission_controller', {
    channel: request.channel,
    storageChannel: request.storageChannel,
    requestId: request.id,
    decision: 'approved',
    decidedBy: humanId,
    decidedByRole: 'sovereign',
    authMethod: 'manual',
    decidedByType: decision.decidedByType ?? 'human',
    authenticated: decision.authenticated ?? true,
    payloadHash: request.accountability?.payloadHash,
    effectBinding: request.accountability?.effectBinding,
  });
  return request.id;
}

function approveHold(gateId: string): void {
  const prepared = prepareMissionGateHoldRecord({
    missionId,
    gateId,
    approvalRequestId: requestAndDecide(gateId),
  });
  writeMissionGateHoldRecord(prepared.missionPath, prepared.record);
}

beforeEach(() => {
  previousMissionRole = process.env.MISSION_ROLE;
  previousPersona = process.env.KYBERION_BASE_ROLE;
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_BASE_ROLE = actorId;
  safeRmSync(missionPath, { recursive: true, force: true });
});

afterEach(() => {
  for (const approvalId of approvalIds.splice(0)) {
    safeRmSync(approvalRequestLogicalPath(MISSION_GATE_HOLD_APPROVAL_CHANNEL, approvalId), {
      force: true,
    });
  }
  safeRmSync(approvalEventLogicalPath(MISSION_GATE_HOLD_APPROVAL_CHANNEL), { force: true });
  safeRmSync(missionPath, { recursive: true, force: true });
  if (previousMissionRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = previousMissionRole;
  if (previousPersona === undefined) delete process.env.KYBERION_BASE_ROLE;
  else process.env.KYBERION_BASE_ROLE = previousPersona;
});

useSeparationOfDutiesOverlay(pathResolver.sharedTmp(`sod-overlay-gate-hold-${process.pid}.json`));

describe('required human holds', () => {
  it('come from the catalog template even when the stored definition lost the flag', () => {
    prepareMission();
    expect(
      resolveRequiredHumanHolds(missionId)
        .map((hold) => hold.gateId)
        .sort()
    ).toEqual([GRAPH_GATE, SCOPE_GATE]);
    expect(pendingHumanHolds(missionId).map((hold) => hold.reason)).toEqual([
      'not_approved',
      'not_approved',
    ]);
  });

  it('leave missions of other templates unchanged', async () => {
    prepareMission('code-change-aidlc');
    expect(resolveRequiredHumanHolds(missionId)).toEqual([]);
    const stored = await evaluateStoredMissionGate({
      missionId,
      gateId: SCOPE_GATE,
      humanConfirmed: true,
    });
    expect(stored.evaluation?.verdict).toBe('pass');
  });

  it('hold the tasks of later phases until the person approves', () => {
    prepareMission();
    const tasks = [
      { task_id: 'ingest-scope', phase: 'ingest' },
      { task_id: 'code_graph-code-graph', phase: 'code_graph' },
      { task_id: 'analysis-analyze', phase: 'analysis' },
    ];
    let held = tasksBehindPendingHumanHolds(missionId, missionPath, tasks);
    expect([...held.keys()].sort()).toEqual(['analysis-analyze', 'code_graph-code-graph']);
    expect(held.get('code_graph-code-graph')?.gateId).toBe(SCOPE_GATE);

    approveHold(SCOPE_GATE);
    held = tasksBehindPendingHumanHolds(missionId, missionPath, tasks);
    expect([...held.keys()]).toEqual(['analysis-analyze']);
    expect(held.get('analysis-analyze')?.gateId).toBe(GRAPH_GATE);
  });

  it('fail the gate and block finish while not approved; pass signed once approved', async () => {
    prepareMission();
    const before = await evaluateStoredMissionGate({
      missionId,
      gateId: SCOPE_GATE,
      humanConfirmed: true,
    });
    expect(before.evaluation?.verdict).toBe('fail');
    expect(before.evaluation?.reasons.join(' ')).toMatch(/human hold .* is not approved/u);
    expect(evaluateMissionFinishExitGate(missionPath).reason).toMatch(/Human holds not approved/u);

    approveHold(SCOPE_GATE);
    const proof = missionGateHoldProof(missionId, SCOPE_GATE);
    expect(proof.verified).toBe(true);
    expect('record' in proof && proof.record.approved_by).toBe(humanId);
    const after = await evaluateStoredMissionGate({
      missionId,
      gateId: SCOPE_GATE,
      humanConfirmed: true,
    });
    expect(after.evaluation?.verdict).toBe('pass');
    const view = applyMissionGateHoldProof(missionId, {
      id: SCOPE_GATE,
      checks: [{ kind: 'human_override' }],
    });
    expect(view.checks[0].params).toMatchObject({
      allow: true,
      require_signature: true,
      approved_by: humanId,
    });

    approveHold(GRAPH_GATE);
    expect(evaluateMissionFinishExitGate(missionPath).reason ?? '').not.toMatch(/Human holds/u);
  });

  it('needs a new approval when the gate inputs change after approval', () => {
    prepareMission();
    approveHold(SCOPE_GATE);
    writeJson('evidence/reverse-spec-scope.json', { purpose: 'rebuild' });
    expect(missionGateHoldProof(missionId, SCOPE_GATE)).toEqual({
      verified: false,
      reason: 'inputs_changed_since_approval',
    });
  });

  it('rejects an approval for another gate, a stale one, and a non-human decision', () => {
    prepareMission();
    const scopeApproval = requestAndDecide(SCOPE_GATE);
    expect(() =>
      prepareMissionGateHoldRecord({
        missionId,
        gateId: GRAPH_GATE,
        approvalRequestId: scopeApproval,
      })
    ).toThrow(/approval_other_gate/u);

    writeJson('evidence/reverse-spec-scope.json', { purpose: 'changed after request' });
    expect(() =>
      prepareMissionGateHoldRecord({
        missionId,
        gateId: SCOPE_GATE,
        approvalRequestId: scopeApproval,
      })
    ).toThrow(/inputs of REVERSE_SPEC_SCOPE_CONFIRMED changed/u);

    // The store already refuses a non-human decision of a human_only request.
    expect(() => requestAndDecide(SCOPE_GATE, { decidedByType: 'agent' })).toThrow(
      /requires a human decider/u
    );
    // An undecided (pending) request is not an approval.
    const pending = createMissionGateHoldApprovalRequest({ missionId, gateId: SCOPE_GATE });
    approvalIds.push(pending.id);
    expect(() =>
      prepareMissionGateHoldRecord({ missionId, gateId: SCOPE_GATE, approvalRequestId: pending.id })
    ).toThrow(/requires an approved mission_gate request/u);
  });

  it('rejects a proof record the agent writes itself', () => {
    prepareMission();
    const recordPath = missionGateHoldRecordPath(missionPath, SCOPE_GATE);
    const forge = (record: Record<string, unknown>) => {
      safeMkdir(nodePath.dirname(recordPath), { recursive: true });
      safeWriteFile(recordPath, JSON.stringify(record));
      return missionGateHoldProof(missionId, SCOPE_GATE);
    };
    const base = {
      gate_id: SCOPE_GATE,
      phase: 'ingest',
      input_digest: 'x',
      ...signHumanOverride({ gateId: SCOPE_GATE, approvedBy: humanId }),
    };
    // Self-signed with the local key, no approval behind it.
    expect(forge({ ...base, approval_request_id: 'not-a-request' }).verified).toBe(false);
    // A real approval, but the record names a different approver.
    const approved = prepareMissionGateHoldRecord({
      missionId,
      gateId: SCOPE_GATE,
      approvalRequestId: requestAndDecide(SCOPE_GATE),
    }).record;
    expect(
      forge({
        ...approved,
        ...signHumanOverride({ gateId: SCOPE_GATE, approvedBy: actorId }),
      })
    ).toEqual({ verified: false, reason: 'record_other_approver' });
    // A tampered signature.
    expect(forge({ ...approved, signature: `${approved.signature}00` })).toEqual({
      verified: false,
      reason: 'signature_invalid',
    });
    expect(forge(approved).verified).toBe(true);
  });

  it('refuses to file a request for a gate without a stored definition', () => {
    prepareMission();
    expect(() =>
      createMissionGateHoldApprovalRequest({ missionId, gateId: 'NO_SUCH_GATE' })
    ).toThrow(/MISSION_GATE_NOT_FOUND/u);
  });
});
