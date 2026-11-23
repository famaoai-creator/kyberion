/**
 * libs/core/mission/mission-gate-hold-proof.ts
 *
 * Proof reader for required human holds on mission gates.
 *
 * A gate check `human_override` with `params.require_signature: true` (set in
 * the workflow catalog) is a required hold: the person must decide it. An
 * HMAC signature alone cannot prove that — the agent holds the same signing
 * key — so a hold counts as passed only when its proof record
 * (`gates/human-holds/<GATE>.json`, written by `gate-pass
 * --approval-request-id`) is backed by:
 *   - an approved `mission_gate` request on the `mission-gate-pass` channel,
 *     for this mission, bound to the effect `mission-gate-pass:<MISSION>:<GATE>`
 *     and to the payload hash of {mission, gate, phase, input_digest};
 *   - a human-only final decision with an authenticated human decider on a
 *     human-proof surface, who is the record's `approved_by`;
 *   - a signHumanOverride signature that verifies for gate/approver/time;
 *   - gate inputs that still match the approved `input_digest` (editing the
 *     scope or the frozen code graph after approval needs a new decision).
 * Anything else fails closed. Proof readers never throw.
 *
 * Required holds come from the mission's catalog template
 * (`process_template.workflow_id`) united with the stored gate definitions, so
 * editing `gates/definitions/*.json` cannot drop a hold.
 */
import * as nodePath from 'node:path';
import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';
import { loadApprovalRequest } from '../governance/approval-store-reader.js';
import { NON_HUMAN_PROOF_AUTH_METHODS } from '../governance/approval-assurance.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import { readJson } from '../foundation/json.js';
import { findMissionPath } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir } from '../secure-io.js';
import type { MissionGateCheck, MissionGateDefinition } from './mission-gate-engine.js';
import { verifyHumanOverrideSignature } from './mission-gate-engine.js';
import { fingerprintMissionGateInputs } from './mission-gate-input-fingerprint.js';
import {
  MISSION_GATE_HOLD_APPROVAL_CHANNEL,
  missionGateHoldApprovalPayload,
  missionGateHoldEffectBinding,
  missionGateHoldRecordName,
} from './mission-gate-hold-payload.js';
import {
  loadMissionPhaseGateDefinitionAtPath,
  type PersistedPhaseGateDefinition,
} from './mission-phase-gate-definition-reader.js';
import { loadMissionStateAtPath } from './mission-state-reader.js';
import { loadMissionWorkflowCatalog, normalizeWorkflowPhases } from './mission-workflow-catalog.js';

export interface RequiredHumanHold {
  gateId: string;
  phase: string;
}

export interface MissionGateHoldRecord {
  gate_id: string;
  phase: string;
  approval_request_id: string;
  input_digest: string;
  approved_by: string;
  approved_at: string;
  signature: string;
}

export type MissionGateHoldProof =
  | { verified: true; record: MissionGateHoldRecord; approval: ApprovalRequestRecord }
  | { verified: false; reason: string };

export function isRequiredHumanHoldCheck(check: { kind?: string; params?: unknown }): boolean {
  return (
    check.kind === 'human_override' &&
    Boolean(check.params) &&
    (check.params as Record<string, unknown>).require_signature === true
  );
}

function gateHasRequiredHold(gate: { checks?: MissionGateCheck[] } | undefined): boolean {
  return Boolean(gate?.checks?.some((check) => isRequiredHumanHoldCheck(check)));
}

export function missionGateHoldRecordPath(missionPath: string, gateId: string): string {
  return assertSafeRepositoryPath(
    nodePath.join(missionPath, 'gates', 'human-holds', missionGateHoldRecordName(gateId)),
    { allowMissingLeaf: true }
  );
}

function readMissionState(missionPath: string) {
  const statePath = nodePath.join(missionPath, 'mission-state.json');
  return safeExistsSync(statePath) ? loadMissionStateAtPath(statePath) : null;
}

/** Phase order of the mission's process template (empty when it has none). */
export function missionProcessPhaseOrder(missionPath: string): string[] {
  const phases = (readMissionState(missionPath) as Record<string, any> | null)?.process_template
    ?.phases;
  return Array.isArray(phases) ? phases.map((phase: unknown) => String(phase)) : [];
}

export function loadStoredMissionGateDefinitions(
  missionPath: string,
  missionId: string
): PersistedPhaseGateDefinition[] {
  const dir = nodePath.join(missionPath, 'gates', 'definitions');
  if (!safeExistsSync(dir)) return [];
  const definitions: PersistedPhaseGateDefinition[] = [];
  for (const entry of safeReaddir(dir) as string[]) {
    if (!entry.endsWith('.json')) continue;
    try {
      definitions.push(
        loadMissionPhaseGateDefinitionAtPath(
          assertSafeRepositoryPath(nodePath.join(dir, entry)),
          missionId
        )
      );
    } catch {
      // An unreadable definition is reported by the gate evaluators.
    }
  }
  return definitions;
}

/** Required holds of the mission: catalog template ∪ stored definitions. */
export function resolveRequiredHumanHolds(
  missionId: string,
  missionPath?: string
): RequiredHumanHold[] {
  const upper = missionId.trim().toUpperCase();
  const dir = missionPath ?? findMissionPath(upper);
  if (!dir) return [];
  const holds = new Map<string, RequiredHumanHold>();
  const workflowId = String(
    (readMissionState(dir) as Record<string, any> | null)?.process_template?.workflow_id || ''
  );
  if (workflowId) {
    const template = (loadMissionWorkflowCatalog().templates || []).find(
      (entry) => entry.id === workflowId
    );
    for (const spec of template ? normalizeWorkflowPhases(template.phases).specs : []) {
      for (const gate of [spec.entry_gate, spec.exit_gate]) {
        if (gate && gateHasRequiredHold(gate))
          holds.set(gate.id, { gateId: gate.id, phase: spec.id });
      }
    }
  }
  for (const definition of loadStoredMissionGateDefinitions(dir, upper)) {
    if (gateHasRequiredHold(definition.gate))
      holds.set(definition.gate.id, { gateId: definition.gate.id, phase: definition.phase });
  }
  return [...holds.values()];
}

/** Fingerprint of the stored gate's declared inputs (what the human approves). */
export function missionGateHoldInputDigest(
  missionPath: string,
  missionId: string,
  gateId: string
): { digest: string; definition: PersistedPhaseGateDefinition } | null {
  const definition = loadStoredMissionGateDefinitions(missionPath, missionId).find(
    (entry) => entry.gate.id === gateId
  );
  if (!definition) return null;
  return { digest: fingerprintMissionGateInputs(definition.gate, missionPath), definition };
}

function stringField(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? (record[key] as string) : '';
}

/**
 * Verify an approval for a hold of this gate and input digest. Shared by the
 * proof reader and by the apply step (which checks it before signing).
 */
export function verifyMissionGateHoldApproval(
  approval: ApprovalRequestRecord | null | undefined,
  input: { missionId: string; gateId: string; phase: string; inputDigest: string }
): { verified: true; humanDecider: string } | { verified: false; reason: string } {
  const upper = input.missionId.trim().toUpperCase();
  if (!approval || approval.kind !== 'mission_gate' || approval.status !== 'approved') {
    return { verified: false, reason: 'approval_not_approved' };
  }
  if (approval.source?.missionId?.toUpperCase() !== upper) {
    return { verified: false, reason: 'approval_other_mission' };
  }
  if (
    approval.accountability?.effectBinding !== missionGateHoldEffectBinding(upper, input.gateId)
  ) {
    return { verified: false, reason: 'approval_other_gate' };
  }
  const payloadHash = computeApprovalPayloadHash(
    missionGateHoldApprovalPayload({
      missionId: upper,
      gateId: input.gateId,
      phase: input.phase,
      inputDigest: input.inputDigest,
    })
  );
  if (approval.accountability?.payloadHash !== payloadHash) {
    return { verified: false, reason: 'approval_other_inputs' };
  }
  if (approval.accountability?.finalDecision !== 'human_only') {
    return { verified: false, reason: 'approval_not_human_only' };
  }
  const human = approval.workflow?.approvals?.find(
    (decision) =>
      decision.status === 'approved' &&
      decision.decidedByType === 'human' &&
      decision.authenticated === true &&
      !(decision.authMethod && NON_HUMAN_PROOF_AUTH_METHODS.has(decision.authMethod)) &&
      decision.payloadHash === approval.accountability?.payloadHash &&
      decision.effectBinding === approval.accountability?.effectBinding
  );
  if (!human) return { verified: false, reason: 'approval_not_human' };
  const humanDecider = String(human.approvedBy || approval.decidedBy || '').trim();
  if (!humanDecider) return { verified: false, reason: 'approval_decider_unknown' };
  return { verified: true, humanDecider };
}

/** Is this gate's human hold proven for the mission's current gate inputs? */
export function missionGateHoldProof(missionId: string, gateId: string): MissionGateHoldProof {
  try {
    const upper = missionId.trim().toUpperCase();
    const missionPath = findMissionPath(upper);
    if (!missionPath) return { verified: false, reason: 'mission_not_found' };
    const recordPath = missionGateHoldRecordPath(missionPath, gateId);
    if (!safeExistsSync(recordPath)) return { verified: false, reason: 'not_approved' };
    const raw = readJson<Record<string, unknown>>(recordPath);
    const record: MissionGateHoldRecord = {
      gate_id: stringField(raw, 'gate_id'),
      phase: stringField(raw, 'phase'),
      approval_request_id: stringField(raw, 'approval_request_id'),
      input_digest: stringField(raw, 'input_digest'),
      approved_by: stringField(raw, 'approved_by'),
      approved_at: stringField(raw, 'approved_at'),
      signature: stringField(raw, 'signature'),
    };
    if (Object.values(record).some((value) => !value)) {
      return { verified: false, reason: 'record_incomplete' };
    }
    if (record.gate_id !== gateId) return { verified: false, reason: 'record_other_gate' };
    if (!verifyHumanOverrideSignature(gateId, raw)) {
      return { verified: false, reason: 'signature_invalid' };
    }
    const current = missionGateHoldInputDigest(missionPath, upper, gateId);
    if (!current) return { verified: false, reason: 'gate_definition_missing' };
    if (current.definition.phase !== record.phase) {
      return { verified: false, reason: 'record_other_phase' };
    }
    if (current.digest !== record.input_digest) {
      return { verified: false, reason: 'inputs_changed_since_approval' };
    }
    const approval = loadApprovalRequest(
      MISSION_GATE_HOLD_APPROVAL_CHANNEL,
      record.approval_request_id
    );
    const decision = verifyMissionGateHoldApproval(approval, {
      missionId: upper,
      gateId,
      phase: record.phase,
      inputDigest: record.input_digest,
    });
    if ('reason' in decision) return { verified: false, reason: decision.reason };
    if (decision.humanDecider !== record.approved_by) {
      return { verified: false, reason: 'record_other_approver' };
    }
    return { verified: true, record, approval: approval! };
  } catch (error) {
    const code = /\[([A-Z0-9_]+)\]/u.exec(error instanceof Error ? error.message : String(error));
    return { verified: false, reason: `proof_unreadable:${code?.[1] ?? 'error'}` };
  }
}

export interface PendingHumanHold extends RequiredHumanHold {
  reason: string;
}

/** Required holds of the mission whose proof does not verify. */
export function pendingHumanHolds(missionId: string, missionPath?: string): PendingHumanHold[] {
  const pending: PendingHumanHold[] = [];
  for (const hold of resolveRequiredHumanHolds(missionId, missionPath)) {
    const proof = missionGateHoldProof(missionId, hold.gateId);
    if ('reason' in proof) pending.push({ ...hold, reason: proof.reason });
  }
  return pending;
}

/**
 * Task ids that wait for a pending hold: tasks whose phase comes after the
 * phase that owns the hold, in the process template's phase order. Their
 * evidence may be recorded, but they are not completed until the hold is
 * decided.
 */
export function tasksBehindPendingHumanHolds(
  missionId: string,
  missionPath: string,
  tasks: Array<Record<string, unknown>>
): Map<string, PendingHumanHold> {
  const held = new Map<string, PendingHumanHold>();
  const pending = pendingHumanHolds(missionId, missionPath);
  if (pending.length === 0) return held;
  const order = missionProcessPhaseOrder(missionPath);
  for (const task of tasks) {
    const taskPhase = order.indexOf(String(task.phase || ''));
    if (taskPhase < 0) continue;
    const blocking = pending.find((hold) => {
      const holdPhase = order.indexOf(hold.phase);
      return holdPhase >= 0 && taskPhase > holdPhase;
    });
    if (blocking) held.set(String(task.task_id || ''), blocking);
  }
  return held;
}

/**
 * Gate evaluation view of the hold. A required human_override check gets the
 * signed params of a verified proof, or `allow: false` with the reason; a gate
 * that is a required hold through the catalog is marked even when its stored
 * definition lost the flag. Any other gate with a human_override check gets
 * the signed params when it has a verified proof (so it also passes under
 * KYBERION_GATE_OVERRIDE_SIGNATURE=enforce) and is unchanged otherwise.
 */
export function applyMissionGateHoldProof(
  missionId: string,
  gate: MissionGateDefinition,
  options: {
    requiredGateIds?: ReadonlySet<string>;
    /**
     * A record the apply step built from an approval it has just verified
     * (gate-pass --approval-request-id), so the gate is evaluated before the
     * proof file is written. Never taken from disk or from a caller's input.
     */
    pendingRecord?: MissionGateHoldRecord;
  } = {}
): MissionGateDefinition {
  if (!gate.checks.some((check) => check.kind === 'human_override')) return gate;
  const required =
    gateHasRequiredHold(gate) ||
    (
      options.requiredGateIds ??
      new Set(resolveRequiredHumanHolds(missionId).map((hold) => hold.gateId))
    ).has(gate.id);
  const proof:
    { verified: true; record: MissionGateHoldRecord } | { verified: false; reason: string } =
    options.pendingRecord && options.pendingRecord.gate_id === gate.id
      ? { verified: true, record: options.pendingRecord }
      : missionGateHoldProof(missionId, gate.id);
  if (!required && 'reason' in proof) return gate;
  return {
    ...gate,
    checks: gate.checks.map((check) => {
      if (check.kind !== 'human_override') return check;
      const base = { ...(check.params || {}), ...(required ? { require_signature: true } : {}) };
      if ('reason' in proof) {
        return {
          ...check,
          params: {
            ...base,
            allow: false,
            reason: `human hold ${gate.id} is not approved (${proof.reason}) — run: pnpm mission gate-pass ${missionId.toUpperCase()} ${gate.id} --request-approval`,
          },
        };
      }
      return {
        ...check,
        params: {
          ...base,
          allow: true,
          approved_by: proof.record.approved_by,
          approved_at: proof.record.approved_at,
          signature: proof.record.signature,
          approval_request_id: proof.record.approval_request_id,
        },
      };
    }),
  };
}

/**
 * `isHeld` predicate for the task auto-complete paths (record-evidence,
 * review-task): resolved once, on first use, from the board as it is then.
 * A proof that does not verify counts as pending; an error reading the
 * catalog propagates, so the command fails instead of completing the task.
 */
export function humanHoldTaskBlocker(
  missionId: string,
  missionPath: string,
  readTasks: () => Array<Record<string, unknown>>
): (taskId: string) => PendingHumanHold | undefined {
  let held: Map<string, PendingHumanHold> | undefined;
  return (taskId) => {
    held ??= tasksBehindPendingHumanHolds(missionId, missionPath, readTasks());
    return held.get(taskId);
  };
}

/** The diagnostic for a task that waits for a hold (what — why | next). */
export function formatHumanHoldWait(missionId: string, taskId: string, hold: PendingHumanHold) {
  const upper = missionId.trim().toUpperCase();
  return `task ${taskId} not completed — it comes after the human hold ${hold.gateId} (phase ${hold.phase}), which is not approved (${hold.reason}) | next: pnpm mission gate-pass ${upper} ${hold.gateId} --request-approval, the person approves with pnpm kyberion approvals --approve <id>, then pnpm mission gate-pass ${upper} ${hold.gateId} --approval-request-id <id> and record-evidence again | mission=${upper}`;
}
