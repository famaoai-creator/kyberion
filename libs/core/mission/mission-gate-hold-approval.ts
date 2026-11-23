/**
 * libs/core/mission/mission-gate-hold-approval.ts
 *
 * Request and apply sides of the approval-mediated human hold
 * (`mission_controller gate-pass <ID> <GATE> --request-approval` and
 * `--approval-request-id <id>`). Same trust shape as scope-approve and
 * supersede-task: the agent files a hash-bound `mission_gate` request, the
 * person decides it with `pnpm kyberion approvals --approve <id>`, and the
 * apply step signs the decision with signHumanOverride in the name of the
 * human decider. The proof reader is mission-gate-hold-proof.ts.
 */
import * as nodePath from 'node:path';
import {
  approvalRequesterActorId,
  resolveApprovalRequesterInput,
  type ApprovalRequesterInput,
  type ApprovalRequesterRef,
} from '../governance/approval-requester.js';
import {
  assertApprovalUsable,
  evaluateApprovalUsability,
} from '../governance/approval-separation-of-duties.js';
import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';
import { createApprovalRequest } from '../governance/approval-request-create.js';
import {
  isApprovalRequestExpired,
  listApprovalRequests,
  loadApprovalRequest,
} from '../governance/approval-store-reader.js';
import { validateHumanFinalDecision } from '../governance/approval-human-decision.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import { hasAuthority, resolveIdentityContext } from '../authority.js';
import { baseRoleEnvText } from '../foundation/base-role-env.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { findMissionPath } from '../path-resolver.js';
import { writeJson } from '../foundation/json.js';
import { safeMkdir } from '../secure-io.js';
import { signHumanOverride } from './mission-gate-engine.js';
import {
  MISSION_GATE_HOLD_APPROVAL_CHANNEL,
  missionGateHoldApprovalPayload,
  missionGateHoldEffectBinding,
} from './mission-gate-hold-payload.js';
import {
  missionGateHoldInputDigest,
  missionGateHoldRecordPath,
  verifyMissionGateHoldApproval,
  type MissionGateHoldRecord,
} from './mission-gate-hold-proof.js';

// The CLI entry point (gate-pass) reaches the proof reader through this module.
export {
  pendingHumanHoldBeforePhase,
  resolveRequiredHumanHolds,
  type MissionGateHoldRecord,
} from './mission-gate-hold-proof.js';

const APPROVAL_TTL_MS = 72 * 60 * 60 * 1000;

function assertGateHoldAuthority(): void {
  const identity = resolveIdentityContext();
  if (identity.role !== 'mission_controller' && !hasAuthority('SUDO')) {
    throw new Error('Mission controller authority is required for a human gate hold.');
  }
}

function resolveHoldTarget(missionId: string, gateId: string) {
  const upper = missionId.trim().toUpperCase();
  const missionPath = findMissionPath(upper);
  if (!missionPath) throw new Error(`Mission ${upper} not found`);
  const current = missionGateHoldInputDigest(missionPath, upper, gateId);
  if (!current) {
    throw new Error(
      `[MISSION_GATE_NOT_FOUND] ${upper} has no stored gate definition ${gateId} (gates/definitions/${gateId}.json)`
    );
  }
  return { upper, missionPath, ...current };
}

/** What the person reads before approving (every approval surface shows draft.details). */
function holdApprovalDetails(input: {
  missionId: string;
  gateId: string;
  phase: string;
  inputs: string[];
  note?: string;
  requestedBy: string;
}): string {
  return [
    `Mission: ${input.missionId}`,
    `Gate: ${input.gateId} (exit of phase ${input.phase})`,
    `Gate inputs (approved as they are now): ${input.inputs.join(', ') || '-'}`,
    ...(input.note ? [`Note: ${input.note}`] : []),
    `Requested by: ${input.requestedBy}`,
    `Effect if approved: the human hold ${input.gateId} passes in your name and the mission continues to the next phase. Changing the gate inputs afterwards needs a new approval.`,
  ].join('\n');
}

function declaredInputs(checks: Array<{ params?: Record<string, unknown> }>): string[] {
  const inputs: string[] = [];
  for (const check of checks) {
    for (const key of ['path', 'paths', 'artifact_path', 'deliverable', 'input_paths']) {
      const value = check.params?.[key];
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (typeof entry === 'string' && entry) inputs.push(entry);
      }
    }
  }
  return [...new Set(inputs)];
}

/** Open (or reuse) the human approval request for a gate's hold. */
export function createMissionGateHoldApprovalRequest(input: {
  missionId: string;
  gateId: string;
  note?: string;
  requestedBy?: string;
  requester?: ApprovalRequesterInput;
}): ApprovalRequestRecord {
  assertGateHoldAuthority();
  const target = resolveHoldTarget(input.missionId, input.gateId);
  const phase = target.definition.phase;
  const effectBinding = missionGateHoldEffectBinding(target.upper, input.gateId);
  const payloadHash = computeApprovalPayloadHash(
    missionGateHoldApprovalPayload({
      missionId: target.upper,
      gateId: input.gateId,
      phase,
      inputDigest: target.digest,
    })
  );
  const existing = listApprovalRequests({
    storageChannels: [MISSION_GATE_HOLD_APPROVAL_CHANNEL],
    kind: 'mission_gate',
    status: ['pending', 'approved'],
  }).find(
    (record) =>
      record.source?.missionId?.toUpperCase() === target.upper &&
      record.accountability?.payloadHash === payloadHash &&
      !isApprovalRequestExpired(record) &&
      (record.status !== 'approved' || !evaluateApprovalUsability(record))
  );
  if (existing) return existing;

  const requester: ApprovalRequesterRef = input.requester
    ? resolveApprovalRequesterInput(input.requester)
    : {
        requestedBy:
          input.requestedBy?.trim() ||
          baseRoleEnvText() ||
          getRegisteredEnvText('USER') ||
          'mission_controller',
      };
  const details = holdApprovalDetails({
    missionId: target.upper,
    gateId: input.gateId,
    phase,
    inputs: declaredInputs(target.definition.gate.checks),
    note: input.note?.trim(),
    requestedBy: requester.requestedBy,
  });
  return createApprovalRequest('mission_controller', {
    channel: MISSION_GATE_HOLD_APPROVAL_CHANNEL,
    storageChannel: MISSION_GATE_HOLD_APPROVAL_CHANNEL,
    threadTs: target.upper,
    correlationId: effectBinding,
    requestedBy: requester.requestedBy,
    ...(requester.displayName ? { requestedByDisplayName: requester.displayName } : {}),
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    kind: 'mission_gate',
    draft: {
      title: `Human hold ${input.gateId}: ${target.upper}`,
      summary: `Approve the ${input.gateId} hold of ${target.upper} (phase ${phase}).`,
      details,
      severity: 'high',
    },
    source: { missionId: target.upper },
    requestedByContext: {
      surface: 'terminal',
      actorId: approvalRequesterActorId(requester),
      actorRole: 'mission-gate-pass',
      missionId: target.upper,
    },
    justification: {
      reason: `The workflow requires a person to decide ${input.gateId} before ${target.upper} continues.`,
      requestedEffects: [effectBinding],
      impactSummary: details,
    },
    risk: {
      level: 'high',
      restartScope: 'manual',
      requiresStrongAuth: true,
      policyId: 'MO-02',
    },
    workflow: {
      workflowId: `mo-02-gate-hold-${target.upper}-${input.gateId}`,
      mode: 'all_required',
      requiredRoles: ['sovereign'],
      stages: [],
      approvals: [{ role: 'sovereign', status: 'pending' }],
    },
    accountability: {
      finalDecision: 'human_only',
      payloadHash,
      effectBinding,
    },
  });
}

/**
 * Check an approved request against the gate as it is now and build the
 * signed hold record in the human decider's name. Does not write it: the
 * caller evaluates the gate with the record first and persists it with
 * {@link writeMissionGateHoldRecord} only when the gate passes.
 */
export function prepareMissionGateHoldRecord(input: {
  missionId: string;
  gateId: string;
  approvalRequestId: string;
}): { record: MissionGateHoldRecord; missionPath: string } {
  assertGateHoldAuthority();
  const target = resolveHoldTarget(input.missionId, input.gateId);
  const approvalRequestId = input.approvalRequestId.trim();
  const approval = loadApprovalRequest(MISSION_GATE_HOLD_APPROVAL_CHANNEL, approvalRequestId);
  if (!approval || approval.kind !== 'mission_gate' || approval.status !== 'approved') {
    throw new Error(
      `[POLICY_VIOLATION] gate-pass requires an approved mission_gate request on ${MISSION_GATE_HOLD_APPROVAL_CHANNEL}: ${approvalRequestId}`
    );
  }
  if (isApprovalRequestExpired(approval)) {
    throw new Error(`[POLICY_VIOLATION] gate hold approval has expired: ${approval.id}`);
  }
  // Separation-of-duties consumer id: approval-sod-consumers.contract.test.ts.
  assertApprovalUsable(approval, { consumer: 'mission_gate_pass' });
  const decision = verifyMissionGateHoldApproval(approval, {
    missionId: target.upper,
    gateId: input.gateId,
    phase: target.definition.phase,
    inputDigest: target.digest,
  });
  if ('reason' in decision) {
    throw new Error(
      decision.reason === 'approval_other_inputs'
        ? `[POLICY_VIOLATION] the inputs of ${input.gateId} changed after the approval was requested — request a new approval`
        : `[POLICY_VIOLATION] gate hold approval ${approval.id} does not apply to ${target.upper}/${input.gateId} (${decision.reason})`
    );
  }
  const human = approval.workflow?.approvals?.find(
    (entry) => entry.status === 'approved' && entry.decidedByType === 'human'
  );
  validateHumanFinalDecision({
    accountability: approval.accountability,
    decidedByType: human?.decidedByType,
    authenticated: human?.authenticated,
    authMethod: human?.authMethod,
    payloadHash: human?.payloadHash,
    effectBinding: human?.effectBinding,
    phase: 'recheck',
  });
  const signed = signHumanOverride({ gateId: input.gateId, approvedBy: decision.humanDecider });
  return {
    missionPath: target.missionPath,
    record: {
      gate_id: input.gateId,
      phase: target.definition.phase,
      approval_request_id: approval.id,
      input_digest: target.digest,
      approved_by: String(signed.approved_by),
      approved_at: String(signed.approved_at),
      signature: String(signed.signature),
    },
  };
}

export function writeMissionGateHoldRecord(
  missionPath: string,
  record: MissionGateHoldRecord
): string {
  const recordPath = missionGateHoldRecordPath(missionPath, record.gate_id);
  safeMkdir(nodePath.dirname(recordPath), { recursive: true });
  writeJson(recordPath, record);
  return recordPath;
}
