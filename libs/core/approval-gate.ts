/**
 * Approval Gate v1.0
 * Pre-execution enforcement layer that blocks governed operations
 * until required approvals are obtained.
 */

import { resolveApprovalPolicy } from './approval-policy.js';
import { summarizeApprovalGate } from './approval-gate-summary.js';
import { evaluateDecisionRights, resolveDecisionRightsMatrix } from './decision-rights.js';
import { resolveGoldenRulePriorityOrder, resolveVision } from './vision-resolver.js';
import {
  createApprovalRequest,
  computeApprovalPayloadHash,
  listApprovalRequests,
  lookupSessionApprovalCache,
  recordSessionCacheAutoApproval,
  type ApprovalActionDescriptor,
  type ApprovalRequestRecord,
  type ApprovalRequestSource,
} from './approval-store.js';
import type { GovernedArtifactRole } from './artifact-store.js';
import { auditChain } from './audit-chain.js';
import type { TraceContext } from './src/trace.js';
import { recordGovernanceAction } from './kill-switch.js';
import { notifyOperator } from './operator-notifications.js';

export interface ApprovalGateParams {
  /** Intent being executed. */
  intentId?: string;
  /** Specific operation (e.g. 'secret:set', 'config:update'). */
  operationId: string;
  /** Who is requesting. */
  agentId: string;
  /** Authenticated role of the caller, resolved securely by the IPC/orchestrator layer. */
  callerRole?: string;
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
  /** Pipeline trace context — when provided, decision events are emitted into the active span. */
  trace?: TraceContext;
  /**
   * KC-03: action descriptor consulted against the session approval cache.
   * Only short-circuits require_approval -> approved; deny paths and hardened
   * policies (dual-key, injection-suspected) never consult the cache.
   */
  actionDescriptor?: ApprovalActionDescriptor;
  /** KC-03: originating mission/task/agent, persisted for source-scoped cancellation. */
  source?: ApprovalRequestSource;
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

function extractDecisionRightsContext(
  agentId: string,
  callerRole?: string,
  payload?: Record<string, unknown>
): {
  tenantSlug?: string;
  decisionType?: string;
  actorRole?: string;
  amount?: number;
  riskLevel?: string;
} {
  const payloadData = payload || {};
  const tenantSlug = firstString(
    payloadData.tenant_slug,
    payloadData.tenantSlug,
    payloadData.company_id
  );
  const decisionType = firstString(
    payloadData.decision_type,
    payloadData.decisionType,
    payloadData.operation_type
  );
  // SEC-FIX: Do not use process.env.MISSION_ROLE to avoid confused deputy in IPC scenarios.
  // The callerRole must be securely resolved and passed by the IPC/orchestrator boundary.
  const actorRole = callerRole || agentId;
  const amountValue = payloadData.amount_jpy ?? payloadData.amount ?? payloadData.value;
  const amount =
    typeof amountValue === 'number'
      ? amountValue
      : typeof amountValue === 'string' &&
          amountValue.trim() &&
          Number.isFinite(Number(amountValue))
        ? Number(amountValue)
        : undefined;
  const riskLevel = firstString(payloadData.risk_level, payloadData.riskLevel, payloadData.risk);
  return {
    tenantSlug,
    decisionType,
    actorRole,
    amount,
    riskLevel,
  };
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
  const { intentId, operationId, agentId, callerRole, correlationId, channel, payload, trace } =
    params;
  recordGovernanceAction(agentId, 'approval_gate', operationId, false);

  const decisionRightsContext = extractDecisionRightsContext(agentId, callerRole, payload);
  const decisionRightsMatrix =
    decisionRightsContext.decisionType || decisionRightsContext.tenantSlug
      ? resolveDecisionRightsMatrix(decisionRightsContext.tenantSlug ?? null)
      : null;
  const decisionRightsEvaluation = evaluateDecisionRights(
    decisionRightsMatrix,
    decisionRightsContext
  );
  if (decisionRightsEvaluation && !decisionRightsEvaluation.requiresEscalation) {
    const goldenRulePriority = resolveGoldenRulePriorityOrder(
      resolveVision(decisionRightsContext.tenantSlug ?? null)
    );
    auditChain.record({
      agentId,
      action: 'approval_gate',
      operation: operationId,
      result: 'allowed',
      reason: `Decision rights allow ${decisionRightsEvaluation.decisionType}`,
      metadata: {
        correlationId,
        intentId,
        decisionType: decisionRightsEvaluation.decisionType,
        decisionRightsSource: decisionRightsMatrix?.source_path,
        goldenRulePriority,
      },
    });
    recordGovernanceAction(agentId, 'approval_gate', `${operationId}:allowed`, false);
    return {
      allowed: true,
      status: 'not_required',
      message: `Decision rights allow ${decisionRightsEvaluation.decisionType}`,
    };
  }

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
    trace?.addEvent('approval.not_required', {
      operation_id: operationId,
      agent_id: agentId,
      matched_rule_id: policy.matchedRuleId ?? '',
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

    const expectedPayloadHash = computeApprovalPayloadHash(payload);
    const bindingMismatch =
      matched.accountability?.finalDecision === 'human_only' &&
      ((matched.accountability.payloadHash &&
        matched.accountability.payloadHash !== expectedPayloadHash) ||
        (matched.accountability.effectBinding &&
          matched.accountability.effectBinding !== operationId));

    if (matched.status === 'approved' && !approvalExpired && !bindingMismatch) {
      auditChain.record({
        agentId,
        action: 'approval_gate',
        operation: operationId,
        result: 'allowed',
        reason: 'Existing approval found',
        metadata: { correlationId, intentId, approvalId: matched.id },
      });
      trace?.addEvent('approval.granted', {
        operation_id: operationId,
        agent_id: agentId,
        request_id: matched.id,
        decided_by: matched.decidedBy ?? 'unknown',
        decided_at: matched.decidedAt ?? 'unknown',
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
    const effectiveStatus = bindingMismatch
      ? 'effect_mismatch'
      : approvalExpired
        ? 'expired'
        : matched.status;
    auditChain.record({
      agentId,
      action: 'approval_gate',
      operation: operationId,
      result: 'denied',
      reason: `Existing request is ${effectiveStatus}`,
      metadata: { correlationId, intentId, requestId: matched.id, requestStatus: effectiveStatus },
    });
    trace?.addEvent('approval.blocked', {
      operation_id: operationId,
      agent_id: agentId,
      request_id: matched.id,
      request_status: matched.status,
      reason: `existing request is ${matched.status}`,
    });
    recordGovernanceAction(agentId, 'approval_gate', `${operationId}:denied`, true);
    return {
      allowed: false,
      status: 'pending',
      requestId: matched.id,
      message: `Approval request ${matched.id} is ${effectiveStatus}`,
    };
  }

  // --- Step 2.5 (KC-03): session action cache ---
  // Reached only when policy says require_approval and no existing request
  // matches this correlationId — deny verdicts (rejected/expired/mismatched
  // requests) returned above and are never short-circuited. Hardened policies
  // (dual-key = tier-sensitive secrets, injection-suspected override) bypass
  // the cache entirely, and the descriptor must name this exact operation.
  const sessionCacheEligible =
    policy.matchedRuleId !== 'injection-suspected-override' &&
    !policy.missingRequirements.includes('dual_key_confirmation');
  const descriptor = params.actionDescriptor;
  const cached =
    descriptor &&
    sessionCacheEligible &&
    descriptor.action.trim().toLowerCase() === operationId.trim().toLowerCase()
      ? lookupSessionApprovalCache(descriptor, Date.now(), {
          agentId,
          payloadHash: computeApprovalPayloadHash(payload),
          effectBinding: operationId,
          source: params.source,
        })
      : null;
  if (cached) {
    auditChain.record({
      agentId,
      action: 'approval_gate',
      operation: operationId,
      result: 'allowed',
      reason: 'auto_approved_via_session_cache',
      metadata: {
        correlationId,
        intentId,
        approvalId: cached.grantedByRequestId,
        sessionCacheKey: cached.key,
        grantedBy: cached.grantedBy,
        grantedAt: cached.grantedAt,
      },
    });
    recordSessionCacheAutoApproval(role, {
      entry: cached,
      operationId,
      agentId,
      correlationId,
    });
    trace?.addEvent('approval.auto_approved_via_session_cache', {
      operation_id: operationId,
      agent_id: agentId,
      request_id: cached.grantedByRequestId,
      granted_by: cached.grantedBy,
      granted_at: cached.grantedAt,
    });
    recordGovernanceAction(agentId, 'approval_gate', `${operationId}:allowed`, false);
    return {
      allowed: true,
      status: 'approved',
      requestId: cached.grantedByRequestId,
      message: `Auto-approved via session cache (granted by ${cached.grantedBy} at ${cached.grantedAt})`,
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
    source: params.source,
    accountability: {
      finalDecision: 'human_only',
      payloadHash: computeApprovalPayloadHash(payload),
      effectBinding: operationId,
    },
  });

  auditChain.record({
    agentId,
    action: 'approval_gate',
    operation: operationId,
    result: 'denied',
    reason: 'New approval request created; awaiting decision',
    metadata: { correlationId, intentId, requestId: record.id },
  });
  trace?.addEvent('approval.blocked', {
    operation_id: operationId,
    agent_id: agentId,
    request_id: record.id,
    request_status: 'pending_new',
    reason: 'new approval request created; awaiting decision',
  });
  recordGovernanceAction(agentId, 'approval_gate', `${operationId}:pending`, true);
  void notifyOperator('approval_required', {
    title: draft.title || `Approval required: ${operationId}`,
    body: draft.summary || `Agent ${agentId} requested ${operationId}.`,
    link_hint: `approval request ${record.id}`,
    correlation_id: record.id,
  });

  return {
    allowed: false,
    status: 'pending',
    requestId: record.id,
    message:
      decisionRightsEvaluation?.escalationReason && decisionRightsEvaluation.requiresEscalation
        ? `Approval request ${record.id} created; ${decisionRightsEvaluation.escalationReason}`
        : `Approval request ${record.id} created; awaiting decision`,
  };
}
