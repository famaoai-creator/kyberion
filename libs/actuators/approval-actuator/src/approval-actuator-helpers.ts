import {
  buildGovernedRetryOptions,
  classifyError,
  normalizeRejectionReasonCategory,
  safeReadFile,
  retry,
  executeAdfSteps,
  resolveVars,
} from '@agent/core';
import {
  createApprovalRequest,
  decideApprovalRequest,
  loadApprovalRequest,
  listApprovalRequests,
  type ApprovalJustification,
  type ApprovalRequesterContext,
  type ApprovalRequestDraft,
  type ApprovalRiskProfile,
  type ApprovalTargetDescriptor,
  type ApprovalWorkflowState,
} from '@agent/core/governance';
import type { GovernedArtifactRole } from '@agent/core/artifacts';
import { pathResolver } from '@agent/core';
import { evaluateDecisionRightsOp, requestReviewOp } from './approval-ops.js';

const APPROVAL_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/approval-actuator/manifest.json'
);
const DEFAULT_APPROVAL_RETRY = {
  maxRetries: 2,
  initialDelayMs: 200,
  maxDelayMs: 1500,
  factor: 2,
  jitter: true,
};

function buildRetryOptions() {
  return buildGovernedRetryOptions({
    manifestPath: APPROVAL_MANIFEST_PATH,
    defaults: DEFAULT_APPROVAL_RETRY,
    fallbackCategories: ['resource_unavailable', 'timeout'],
  });
}

export interface ApprovalAction {
  action: 'create' | 'load' | 'decide' | 'list_pending' | 'pipeline';
  steps?: Array<{
    type: 'capture' | 'transform' | 'apply' | 'control';
    op: string;
    params: Record<string, unknown>;
  }>;
  context?: Record<string, unknown>;
  options?: { max_steps?: number; timeout_ms?: number };
  params: {
    role?: GovernedArtifactRole;
    channel: string;
    storageChannel?: string;
    threadTs?: string;
    correlationId?: string;
    requestedBy?: string;
    draft?: ApprovalRequestDraft;
    sourceText?: string;
    requestId?: string;
    decision?: 'approved' | 'rejected';
    decidedBy?: string;
    decidedByRole?: string;
    authMethod?: 'surface_session' | 'totp' | 'passkey' | 'manual';
    decidedByType?: 'human' | 'ai_agent' | 'service';
    authenticated?: boolean;
    payloadHash?: string;
    effectBinding?: string;
    note?: string;
    /** LC-10: closed-vocabulary rejection reason (rejection-reason.ts). */
    reasonCategory?: string;
    requestKind?: 'channel-approval' | 'secret_mutation';
    expiresAt?: string;
    requestedByContext?: ApprovalRequesterContext;
    target?: ApprovalTargetDescriptor;
    justification?: ApprovalJustification;
    risk?: ApprovalRiskProfile;
    workflow?: ApprovalWorkflowState;
    idempotency_key?: string;
  };
}

function resolveParams(value: unknown, context: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveParams(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveParams(item, context)])
    );
  }
  return resolveVars(value, context);
}

async function executeApprovalPipeline(
  steps: NonNullable<ApprovalAction['steps']>,
  initialContext: Record<string, unknown> = {},
  options: ApprovalAction['options'] = {}
) {
  return executeAdfSteps(
    steps,
    { ...initialContext, timestamp: new Date().toISOString() },
    { maxSteps: options.max_steps || 1000, timeoutMs: options.timeout_ms || 60000 },
    {
      capture: async () => {
        throw new Error('[UNKNOWN_OP] Approval actuator does not own capture operations');
      },
      transform: async () => {
        throw new Error('[UNKNOWN_OP] Approval actuator does not own transform operations');
      },
      control: async () => {
        throw new Error('[UNKNOWN_OP] Approval actuator does not own control operations');
      },
      apply: async (op, rawParams, context) => {
        const params = resolveParams(rawParams, context) as Record<string, unknown>;
        const result =
          op === 'evaluate_decision_rights'
            ? evaluateDecisionRightsOp(
                params as unknown as Parameters<typeof evaluateDecisionRightsOp>[0]
              )
            : op === 'request_review'
              ? requestReviewOp(params as unknown as Parameters<typeof requestReviewOp>[0])
              : await handleApprovalAction({
                  action: op as ApprovalAction['action'],
                  params: params as ApprovalAction['params'],
                });
        return { ...context, [String(params.export_as || op)]: result };
      },
    }
  );
}

export async function handleApprovalAction(input: ApprovalAction) {
  if (input.action === 'pipeline') {
    return executeApprovalPipeline(input.steps || [], input.context || {}, input.options);
  }
  const params = input.params || ({} as any);
  const role = params.role || 'mission_controller';
  switch (input.action) {
    case 'create':
      if (!params.threadTs || !params.correlationId || !params.requestedBy || !params.draft) {
        throw new Error('threadTs, correlationId, requestedBy, and draft are required');
      }
      return {
        status: 'created',
        request: createApprovalRequest(role, {
          channel: params.channel,
          storageChannel: params.storageChannel,
          threadTs: params.threadTs,
          correlationId: params.correlationId,
          requestedBy: params.requestedBy,
          draft: params.draft,
          sourceText: params.sourceText,
          kind: params.requestKind,
          expiresAt: params.expiresAt,
          requestedByContext: params.requestedByContext,
          target: params.target,
          justification: params.justification,
          risk: params.risk,
          workflow: params.workflow,
        }),
      };
    case 'load':
      if (!params.requestId) throw new Error('requestId is required');
      return {
        status: 'ok',
        request: await retry(
          async () => loadApprovalRequest(params.channel, params.requestId),
          buildRetryOptions()
        ),
      };
    case 'decide':
      if (!params.requestId || !params.decision || !params.decidedBy) {
        throw new Error('requestId, decision, and decidedBy are required');
      }
      return {
        status: 'ok',
        request: decideApprovalRequest(role, {
          channel: params.channel,
          storageChannel: params.storageChannel,
          requestId: params.requestId,
          decision: params.decision,
          decidedBy: params.decidedBy,
          decidedByRole: params.decidedByRole,
          authMethod: params.authMethod,
          decidedByType: params.decidedByType,
          authenticated: params.authenticated,
          payloadHash: params.payloadHash,
          effectBinding: params.effectBinding,
          note: params.note,
          reasonCategory: normalizeRejectionReasonCategory(params.reasonCategory),
        }),
      };
    case 'list_pending': {
      const storageChannel = params.storageChannel || params.channel;
      const requests = await retry(
        async () => listApprovalRequests({ storageChannels: [storageChannel], status: 'pending' }),
        buildRetryOptions()
      );
      return { status: 'ok', requests };
    }
    default:
      throw new Error(`Unsupported approval action: ${input.action}`);
  }
}
