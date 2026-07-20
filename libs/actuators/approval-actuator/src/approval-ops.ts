import {
  createApprovalRequest,
  enforceApprovalGate,
  evaluateDecisionRights,
  resolveDecisionRightsMatrix,
  listApprovalRequests,
  type GovernedArtifactRole,
} from '@agent/core';

export interface EvaluateDecisionRightsInput {
  operation_id: string;
  correlation_id: string;
  decision_type: string;
  agent_id?: string;
  caller_role?: string;
  channel?: string;
  amount?: number;
  tenant_slug?: string;
  mission_id?: string;
  title?: string;
  summary?: string;
}

export interface DecisionRightsResult {
  allowed: boolean;
  status: 'approved' | 'pending' | 'not_required';
  request_id?: string;
  message?: string;
}

export function evaluateDecisionRightsOp(input: EvaluateDecisionRightsInput): DecisionRightsResult {
  if (!input.operation_id || !input.correlation_id || !input.decision_type) {
    throw new Error(
      '[evaluate_decision_rights] requires operation_id, correlation_id, and decision_type'
    );
  }

  const matrix = resolveDecisionRightsMatrix(input.tenant_slug ?? null);
  const evaluation = evaluateDecisionRights(matrix, {
    decisionType: input.decision_type,
    actorRole: input.caller_role,
    amount: input.amount,
  });
  if (!evaluation || !evaluation.requiresEscalation) {
    return { allowed: true, status: 'not_required' };
  }

  const result = enforceApprovalGate({
    operationId: input.operation_id,
    agentId: input.agent_id || 'mission_controller',
    callerRole: input.caller_role,
    correlationId: input.correlation_id,
    channel: input.channel || 'mission',
    payload: {
      decision_type: input.decision_type,
      ...(typeof input.amount === 'number' && Number.isFinite(input.amount)
        ? { amount: input.amount }
        : {}),
      ...(input.tenant_slug ? { tenant_slug: input.tenant_slug } : {}),
      ...(input.mission_id ? { mission_id: input.mission_id } : {}),
    },
    ...(input.title || input.summary
      ? {
          draft: {
            title: input.title || `Approval required: ${input.operation_id}`,
            summary: input.summary || `${input.decision_type} requires human review.`,
            severity: 'medium' as const,
          },
        }
      : {}),
  });
  return {
    allowed: result.allowed,
    status: result.status,
    ...(result.requestId ? { request_id: result.requestId } : {}),
    ...(result.message ? { message: result.message } : {}),
  };
}

export interface ReviewRequestInput {
  topic: string;
  idempotency_key: string;
  reason?: string;
  evidence?: unknown;
  mission_id?: string;
  correlation_id?: string;
  channel?: string;
  agent_id?: string;
  severity?: 'low' | 'medium' | 'high';
}

export function requestReviewOp(input: ReviewRequestInput) {
  if (!input.topic || !input.idempotency_key) {
    throw new Error('[request_review] requires topic and idempotency_key');
  }
  const channel = input.channel || 'mission';
  const correlationId = input.correlation_id || input.idempotency_key;
  const existing = listApprovalRequests({
    storageChannels: [channel],
    status: ['pending', 'approved'],
  }).find((request) => request.correlationId === correlationId);
  if (existing) {
    return {
      status: existing.status === 'approved' ? ('approved' as const) : ('pending' as const),
      request_id: existing.id,
      review_id: existing.id,
      review_status: existing.status,
      deduplicated: true,
    };
  }
  const evidence =
    typeof input.evidence === 'string' ? input.evidence : JSON.stringify(input.evidence ?? '');
  const role: GovernedArtifactRole = 'mission_controller';
  const request = createApprovalRequest(role, {
    channel,
    threadTs: new Date().toISOString(),
    correlationId,
    requestedBy: input.agent_id || 'mission_controller',
    draft: {
      title: input.topic,
      summary: input.reason || 'Human review requested by the governed pipeline.',
      details: evidence ? `Evidence:\n${evidence}` : undefined,
      severity: input.severity || 'medium',
    },
    source: {
      ...(input.mission_id ? { missionId: input.mission_id } : {}),
      ...(input.agent_id ? { agentId: input.agent_id } : {}),
    },
  });
  return {
    status: 'pending' as const,
    request_id: request.id,
    review_id: request.id,
    review_status: 'pending' as const,
  };
}
