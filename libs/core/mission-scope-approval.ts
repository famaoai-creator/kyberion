/**
 * libs/core/mission-scope-approval.ts
 *
 * Request side of the approval-mediated scope rebaseline for
 * intent-drift-blocked missions.
 *
 * `scope-approve` rewrites a mission's origin intent, so the direct CLI path
 * requires SUDO (`assertCanGrantMissionAuthority`). This module files the
 * governed alternative used when the worker cannot hold SUDO: a hash-bound
 * `mission_gate` approval request that shows the human exactly what is being
 * rebaselined (current origin goal → proposed goal / success condition, plus
 * the drift-gate verdict). The human decides once via
 * `pnpm kyberion approvals --approve <id>`, and the agent applies with
 * `--approval-request-id`. Same trust shape as
 * `mission-work-reconciliation.ts` (PI-05): the authenticated human approval
 * substitutes for SUDO, and the approval is bound by payloadHash to the
 * exact goal/reason/success-condition it approved.
 *
 * The apply-side validation lives in `mission-maintenance.ts`
 * (`assertScopeChangeApproval`) — it must sit inside the lifecycle SCC with
 * the code that consumes it; importing this request-side module from the
 * apply side would close a dependency cycle.
 */

import { getRegisteredEnvText } from './foundation/env.js';
import {
  computeApprovalPayloadHash,
  createApprovalRequest,
  isApprovalRequestExpired,
  listApprovalRequests,
  type ApprovalRequestRecord,
} from './approval-store.js';
import { hasAuthority, resolveIdentityContext } from './authority.js';
import { findMissionPath } from './path-resolver.js';
import {
  MISSION_SCOPE_APPROVAL_CHANNEL,
  scopeApproveApprovalPayload,
  scopeApproveEffectBinding,
} from './mission-scope-payload.js';

export { MISSION_SCOPE_APPROVAL_CHANNEL, scopeApproveApprovalPayload, scopeApproveEffectBinding };

/**
 * Same contract as mission-work-reconciliation: requesting and applying an
 * approval-mediated mutation requires the mission_controller role (the
 * controller CLI self-identifies as it) or SUDO. What it does NOT require is
 * SUDO itself — that is the point of the approval path.
 */
export function assertScopeApprovalAuthority(): void {
  const identity = resolveIdentityContext();
  if (identity.role !== 'mission_controller' && !hasAuthority('SUDO')) {
    throw new Error('Mission controller authority is required for scope approval mediation.');
  }
}

/**
 * The text a human must be able to read before approving. Carried on
 * draft.details so every approval surface (terminal list, Slack, brief)
 * shows *what* is being rebaselined, not just that something is.
 */
export function buildScopeApprovalDetails(input: {
  missionId: string;
  currentGoal: string;
  proposedGoal: string;
  successCondition: string;
  reason: string;
  driftMessage?: string;
  driftScore?: number;
  requestedBy: string;
}): string {
  const lines = [
    `Mission: ${input.missionId.toUpperCase()}`,
    `Current origin goal: ${input.currentGoal || '<none recorded>'}`,
    `Proposed new goal: ${input.proposedGoal}`,
    `Proposed success condition: ${input.successCondition}`,
    `Reason: ${input.reason}`,
  ];
  if (input.driftMessage) {
    const score = typeof input.driftScore === 'number' ? ` (score ${input.driftScore})` : '';
    lines.push(`Drift gate${score}: ${input.driftMessage}`);
  }
  lines.push(`Requested by: ${input.requestedBy}`);
  lines.push(
    'Effect if approved: the origin intent baseline is rewritten to the proposed goal (recorded as an approved scope change), after which `verify → distill → finish` can close the mission.'
  );
  return lines.join('\n');
}

/** Open (or reuse) the human approval request for a scope rebaseline. */
export function createMissionScopeApprovalRequest(input: {
  missionId: string;
  goalSummary: string;
  reason: string;
  successCondition?: string;
  requestedBy?: string;
  /**
   * Display context the caller gathers (e.g. via collectMissionTriageReport)
   * so the human sees what they approve. Kept as inputs — this module
   * deliberately does not import mission-state/intent machinery, which would
   * pull it into the lifecycle dependency cycle.
   */
  currentGoal?: string;
  drift?: { message?: string; driftScore?: number };
}): ApprovalRequestRecord {
  assertScopeApprovalAuthority();
  const missionId = input.missionId.toUpperCase();
  if (!findMissionPath(missionId)) throw new Error(`Mission ${missionId} not found`);

  const goalSummary = String(input.goalSummary || '').trim();
  if (!goalSummary) {
    throw new Error('A non-empty goal summary is required to request a scope approval.');
  }
  const reason = String(input.reason || 'Approved scope adjustment.').trim();
  const successCondition = String(input.successCondition || goalSummary).trim();
  // ISO expiry keeps a stale human approval from rebaselining a mission long
  // after the decision context has moved on (72h, matching PI-05 precedent).
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

  const effectBinding = scopeApproveEffectBinding(missionId);
  const payloadHash = computeApprovalPayloadHash(
    scopeApproveApprovalPayload(missionId, goalSummary, reason, successCondition)
  );
  const existing = listApprovalRequests({
    storageChannels: [MISSION_SCOPE_APPROVAL_CHANNEL],
    kind: 'mission_gate',
    status: ['pending', 'approved'],
  }).find(
    (record) =>
      record.source?.missionId?.toUpperCase() === missionId &&
      record.accountability?.payloadHash === payloadHash &&
      !isApprovalRequestExpired(record)
  );
  if (existing) return existing;

  const requestedBy =
    input.requestedBy?.trim() ||
    getRegisteredEnvText('KYBERION_PERSONA') ||
    getRegisteredEnvText('USER') ||
    'mission_controller';
  const details = buildScopeApprovalDetails({
    missionId,
    currentGoal: String(input.currentGoal || '').trim(),
    proposedGoal: goalSummary,
    successCondition,
    reason,
    driftMessage: input.drift?.message,
    driftScore: input.drift?.driftScore,
    requestedBy,
  });

  return createApprovalRequest('mission_controller', {
    channel: MISSION_SCOPE_APPROVAL_CHANNEL,
    storageChannel: MISSION_SCOPE_APPROVAL_CHANNEL,
    threadTs: missionId,
    correlationId: effectBinding,
    requestedBy,
    expiresAt,
    kind: 'mission_gate',
    draft: {
      title: `Scope rebaseline: ${missionId}`,
      summary: `Approve rewriting the origin intent of ${missionId} to "${goalSummary}".`,
      details,
      severity: 'high',
    },
    source: { missionId },
    requestedByContext: {
      surface: 'terminal',
      actorId: requestedBy,
      actorRole: 'mission-scope-approval',
      missionId,
    },
    justification: {
      reason: `Scope rebaseline for ${missionId}: ${reason}`,
      requestedEffects: [effectBinding],
      impactSummary: details,
    },
    risk: {
      level: 'high',
      restartScope: 'manual',
      requiresStrongAuth: true,
      policyId: 'PI-05',
    },
    workflow: {
      workflowId: `pi-05-scope-approve-${missionId}`,
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
