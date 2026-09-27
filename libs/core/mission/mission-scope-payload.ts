/**
 * libs/core/mission/mission-scope-payload.ts
 *
 * Pure payload helpers for the approval-mediated scope rebaseline, shared by
 * the request side (mission-scope-approval.ts) and the apply side
 * (mission-maintenance.ts). Deliberately dependency-free: importing
 * approval-store here would drag this module into the lifecycle SCC through
 * its callers, which is exactly the cycle the split avoids.
 */

export const MISSION_SCOPE_APPROVAL_CHANNEL = 'mission-scope';

export function scopeApproveEffectBinding(missionId: string): string {
  return `mission-scope-approve:${missionId.toUpperCase()}`;
}

/**
 * Canonical payload hashed into the approval — every field the human
 * approved. Normalization (trim, empty→goal default) lives here so the
 * request and apply sides canonicalize identically by construction — a
 * whitespace-only difference must not produce a different hash.
 */
export function scopeApproveApprovalPayload(
  missionId: string,
  goalSummary: string,
  reason: string,
  successCondition: string
): Record<string, string> {
  const goal = String(goalSummary || '').trim();
  return {
    mission_id: missionId.toUpperCase(),
    action: 'scope_rebaseline',
    goal_summary: goal,
    reason: String(reason || '').trim(),
    success_condition: String(successCondition || '').trim() || goal,
    effect: scopeApproveEffectBinding(missionId),
  };
}
