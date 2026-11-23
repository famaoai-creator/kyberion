/**
 * libs/core/mission/mission-gate-hold-payload.ts
 *
 * Pure payload helpers for the approval-mediated human hold of a mission
 * gate (`gate-pass --request-approval` / `--approval-request-id`), shared by
 * the request/apply side (mission-gate-hold-approval.ts) and the proof reader
 * (mission-gate-hold-proof.ts). Dependency-free on purpose: both sides must
 * canonicalize the same payload by construction.
 */

export const MISSION_GATE_HOLD_APPROVAL_CHANNEL = 'mission-gate-pass';

export function missionGateHoldEffectBinding(missionId: string, gateId: string): string {
  return `mission-gate-pass:${missionId.trim().toUpperCase()}:${gateId.trim()}`;
}

/**
 * Canonical payload hashed into the approval: the human approves this gate
 * of this mission with these exact gate inputs (fingerprint of the declared
 * evidence files and checker arguments).
 */
export function missionGateHoldApprovalPayload(input: {
  missionId: string;
  gateId: string;
  phase: string;
  inputDigest: string;
}): Record<string, string> {
  return {
    mission_id: input.missionId.trim().toUpperCase(),
    gate_id: input.gateId.trim(),
    phase: input.phase.trim(),
    input_digest: input.inputDigest,
    effect: missionGateHoldEffectBinding(input.missionId, input.gateId),
  };
}

/** File-name-safe gate id for the hold proof record. */
export function missionGateHoldRecordName(gateId: string): string {
  return `${gateId.trim().replace(/[^a-zA-Z0-9._-]/gu, '-')}.json`;
}
