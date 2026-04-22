/**
 * Approval Gate v1.0
 * Pre-execution enforcement layer that blocks governed operations
 * until required approvals are obtained.
 */

import { resolveApprovalPolicy } from './approval-policy.js';
import {
  createApprovalRequest,
  listApprovalRequests,
  type ApprovalRequestRecord,
} from './approval-store.js';
import type { GovernedArtifactRole } from './artifact-store.js';
import { auditChain } from './audit-chain.js';

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
    severity?: 'low' | 'medium' | 'high';
  };
}

export interface ApprovalGateResult {
  allowed: boolean;
  status: 'approved' | 'pending' | 'not_required';
  requestId?: string;
  message?: string;
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
  role: GovernedArtifactRole = 'mission_controller',
): ApprovalGateResult {
  const { intentId, operationId, agentId, correlationId, channel, payload } = params;

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
    return { allowed: true, status: 'not_required', message: 'No approval required' };
  }

  // --- Step 2: Search for an existing request matching this correlationId ---
  const existing = listApprovalRequests({ storageChannels: [channel] });
  const matched = existing.find(
    (r: ApprovalRequestRecord) => r.correlationId === correlationId,
  );

  if (matched) {
    if (matched.status === 'approved') {
      auditChain.record({
        agentId,
        action: 'approval_gate',
        operation: operationId,
        result: 'allowed',
        reason: 'Existing approval found',
        metadata: { correlationId, intentId, approvalId: matched.id },
      });
      return {
        allowed: true,
        status: 'approved',
        requestId: matched.id,
        message: `Approved by ${matched.decidedBy ?? 'unknown'} at ${matched.decidedAt ?? 'unknown'}`,
      };
    }

    // Pending, expired, rejected, etc. — block execution.
    auditChain.record({
      agentId,
      action: 'approval_gate',
      operation: operationId,
      result: 'denied',
      reason: `Existing request is ${matched.status}`,
      metadata: { correlationId, intentId, requestId: matched.id, requestStatus: matched.status },
    });
    return {
      allowed: false,
      status: 'pending',
      requestId: matched.id,
      message: `Approval request ${matched.id} is ${matched.status}`,
    };
  }

  // --- Step 3: Create a new approval request ---
  const draft = params.draft ?? {
    title: `Approval required: ${operationId}`,
    summary: `Agent ${agentId} requests approval for operation "${operationId}" (correlation: ${correlationId}).`,
    severity: 'medium' as const,
  };

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

  return {
    allowed: false,
    status: 'pending',
    requestId: record.id,
    message: `Approval request ${record.id} created; awaiting decision`,
  };
}
