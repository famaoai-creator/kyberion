/**
 * Approval Gate v1.0
 * Pre-execution enforcement layer that blocks governed operations
 * until required approvals are obtained.
 */

import { resolveApprovalPolicy } from './approval-policy.js';
import { summarizeApprovalGate } from './approval-gate-summary.js';
import {
  createApprovalRequest,
  listApprovalRequests,
  type ApprovalRequestRecord,
} from './approval-store.js';
import type { GovernedArtifactRole } from './artifact-store.js';
import { auditChain } from './audit-chain.js';
import { recordGovernanceAction } from './kill-switch.js';

export interface ApprovalGateParams {
  /** Intent being executed. */
  intentId?: string;
  /** Specific operation (e.g. 'secret:set', 'config:update'). */
  operationId: string;
  /** Who is requesting. */
  agentId: string;
  /** Correlation id to match approval requests. */
  correlationId: string;
  /** Surface channel. */
  channel: string;
  /** Operation-specific data. */
  payload?: Record<string, unknown>;
  /** Optional draft for the approval request; auto-generated if omitted. */
  draft?: {
    title: string;
    summary: string;
    details?: string;
    severity?: 'low' | 'medium' | 'high';
  };
}

export interface ApprovalGateResult {
  allowed: boolean;
  status: 'approved' | 'pending' | 'not_required';
  requestId?: string;
  message?: string;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function buildApprovalDraft(params: {
  operationId: string;
  agentId: string;
  correlationId: string;
  payload?: Record<string, unknown>;
  intentId?: string;
}): { title: string; summary: string; details: string; severity: 'low' | 'medium' | 'high' } {
  const payload = params.payload || {};
  const artifactRefs = toStringList(
    payload.artifacts ??
      payload.artifactRefs ??
      payload.artifact_refs ??
      payload.outputs ??
      payload.output_refs
  );
  const approvalBoundaryRaw =
    payload.approvalBoundary ?? payload.approval_boundary ?? payload.approval_boundary_summary;
  const approvalBoundary =
    approvalBoundaryRaw && typeof approvalBoundaryRaw === 'object'
      ? (approvalBoundaryRaw as { requiredFor?: string[]; defaultAction?: string })
      : undefined;
  const rationale = firstString(
    payload.rationale,
    payload.reason,
    payload.justification,
    payload.context_rationale
  );
  const acceptanceCriteria = toStringList(
    payload.acceptance_criteria ??
      payload.acceptanceCriteria ??
      payload.remaining_acceptance_criteria
  );
  const expectedOutputs = toStringList(
    payload.expected_outputs ?? payload.expectedOutputs ?? payload.artifacts
  );
  const consequences = toStringList(
    payload.consequences ?? payload.impacts ?? payload.resulting_effects
  );
  const severity = (() => {
    const value = firstString(payload.severity, payload.risk_level, payload.riskLevel);
    if (value === 'high' || value === 'critical') return 'high';
    if (value === 'low' || value === 'medium') return value;
    return 'medium';
  })();
  const summary = summarizeApprovalGate({
    taskId: params.operationId,
    artifacts: artifactRefs,
    approvalBoundary:
      approvalBoundary && Array.isArray(approvalBoundary.requiredFor)
        ? {
            requiredFor: approvalBoundary.requiredFor,
            defaultAction: (approvalBoundary.defaultAction as any) || 'requires-human-approval',
          }
        : undefined,
  });
  const details = [
    `Operation: ${params.operationId}`,
    `Agent: ${params.agentId}`,
    `Correlation: ${params.correlationId}`,
    '',
    'Rationale:',
    `- ${rationale || 'not provided'}`,
    '',
    'Acceptance criteria:',
    acceptanceCriteria.length > 0
      ? acceptanceCriteria.map((entry) => `- ${entry}`).join('\n')
      : '- none provided',
    '',
    'Expected outputs:',
    expectedOutputs.length > 0
      ? expectedOutputs.map((entry) => `- ${entry}`).join('\n')
      : '- none provided',
    '',
    'Consequences:',
    consequences.length > 0
      ? consequences.map((entry) => `- ${entry}`).join('\n')
      : '- not provided',
    '',
    summary,
  ].join('\n');

  return {
    title: `Approval required: ${params.operationId}`,
    summary,
    details,
    severity,
  };
}

/**
 * Enforce the approval gate before executing a governed operation.
 *
 * 1. Evaluates the approval policy for the given intent/payload.
 * 2. If no approval is required, returns immediately.
 * 3. Otherwise looks for an existing approved/pending request that
 *    matches the correlationId, or creates a new one.
 */
export function enforceApprovalGate(
  params: ApprovalGateParams,
  role: GovernedArtifactRole = 'mission_controller'
): ApprovalGateResult {
  const { intentId, operationId, agentId, correlationId, channel, payload } = params;
  recordGovernanceAction(agentId, 'approval_gate', operationId, false);

  // --- Step 1: Resolve policy ---
  const policy = resolveApprovalPolicy({ intentId, payload });

  if (!policy.requiresApproval) {
    auditChain.record({
      agentId,
      action: 'approval_gate',
      operation: operationId,
      result: 'allowed',
      reason: 'No approval required by policy',
      metadata: { correlationId, intentId, matchedRuleId: policy.matchedRuleId },
    });
    recordGovernanceAction(agentId, 'approval_gate', `${operationId}:allowed`, false);
    return { allowed: true, status: 'not_required', message: 'No approval required' };
  }

  // --- Step 2: Search for an existing request matching this correlationId ---
  const existing = listApprovalRequests({ storageChannels: [channel] });
  const matched = existing.find((r: ApprovalRequestRecord) => r.correlationId === correlationId);

  if (matched) {
    // An approved record that carries an expiry must not be reused past it —
    // otherwise a single human "yes" becomes a standing, permanent grant
    // (security review CR-4). Records with no expiresAt keep prior behavior.
    const approvalExpired =
      matched.status === 'approved' &&
      typeof matched.expiresAt === 'string' &&
      Number.isFinite(Date.parse(matched.expiresAt)) &&
      Date.parse(matched.expiresAt) <= Date.now();

    if (matched.status === 'approved' && !approvalExpired) {
      auditChain.record({
        agentId,
        action: 'approval_gate',
        operation: operationId,
        result: 'allowed',
        reason: 'Existing approval found',
        metadata: { correlationId, intentId, approvalId: matched.id },
      });
      recordGovernanceAction(agentId, 'approval_gate', `${operationId}:allowed`, false);
      return {
        allowed: true,
        status: 'approved',
        requestId: matched.id,
        message: `Approved by ${matched.decidedBy ?? 'unknown'} at ${matched.decidedAt ?? 'unknown'}`,
      };
    }

    // Pending, expired, rejected, or approved-but-expired — block execution.
    const effectiveStatus = approvalExpired ? 'expired' : matched.status;
    auditChain.record({
      agentId,
      action: 'approval_gate',
      operation: operationId,
      result: 'denied',
      reason: `Existing request is ${effectiveStatus}`,
      metadata: { correlationId, intentId, requestId: matched.id, requestStatus: effectiveStatus },
    });
    recordGovernanceAction(agentId, 'approval_gate', `${operationId}:denied`, true);
    return {
      allowed: false,
      status: 'pending',
      requestId: matched.id,
      message: `Approval request ${matched.id} is ${effectiveStatus}`,
    };
  }

  // --- Step 3: Create a new approval request ---
  const draft =
    params.draft ?? buildApprovalDraft({ operationId, agentId, correlationId, payload, intentId });

  const record = createApprovalRequest(role, {
    channel,
    threadTs: new Date().toISOString(),
    correlationId,
    requestedBy: agentId,
    draft,
  });

  auditChain.record({
    agentId,
    action: 'approval_gate',
    operation: operationId,
    result: 'denied',
    reason: 'New approval request created; awaiting decision',
    metadata: { correlationId, intentId, requestId: record.id },
  });
  recordGovernanceAction(agentId, 'approval_gate', `${operationId}:pending`, true);

  return {
    allowed: false,
    status: 'pending',
    requestId: record.id,
    message: `Approval request ${record.id} created; awaiting decision`,
  };
}
