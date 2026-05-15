import {
  createStandardYargs,
  logger,
  safeReadFile,
  withRetry,
  classifyError,
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
import type {
  GovernedArtifactRole,
} from '@agent/core/artifacts';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathResolver } from '@agent/core';

const APPROVAL_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/approval-actuator/manifest.json');
const DEFAULT_APPROVAL_RETRY = {
  maxRetries: 2,
  initialDelayMs: 200,
  maxDelayMs: 1500,
  factor: 2,
  jitter: true,
};

let cachedRecoveryPolicy: Record<string, any> | null = null;

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(safeReadFile(APPROVAL_MANIFEST_PATH, { encoding: 'utf8' }) as string);
    cachedRecoveryPolicy = isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
  } catch {
    cachedRecoveryPolicy = {};
  }
  return cachedRecoveryPolicy;
}

function buildRetryOptions() {
  const policy = loadRecoveryPolicy();
  const retry = isPlainObject(policy.retry) ? policy.retry : DEFAULT_APPROVAL_RETRY;
  const retryableCategories = new Set<string>(
    Array.isArray(policy.retryable_categories) ? policy.retryable_categories.map(String) : [],
  );
  return {
    ...DEFAULT_APPROVAL_RETRY,
    ...retry,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      return retryableCategories.size > 0
        ? retryableCategories.has(classification.category)
        : classification.category === 'resource_unavailable' || classification.category === 'timeout';
    },
  };
}

interface ApprovalAction {
  action: 'create' | 'load' | 'decide' | 'list_pending';
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
    note?: string;
    requestKind?: 'channel-approval' | 'secret_mutation';
    expiresAt?: string;
    requestedByContext?: ApprovalRequesterContext;
    target?: ApprovalTargetDescriptor;
    justification?: ApprovalJustification;
    risk?: ApprovalRiskProfile;
    workflow?: ApprovalWorkflowState;
  };
}

export async function handleAction(input: ApprovalAction) {
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
        request: await withRetry(
          async () => loadApprovalRequest(params.channel, params.requestId),
          buildRetryOptions(),
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
          note: params.note,
        }),
      };
    case 'list_pending': {
      const storageChannel = params.storageChannel || params.channel;
      const requests = await withRetry(
        async () => listApprovalRequests({ storageChannels: [storageChannel], status: 'pending' }),
        buildRetryOptions(),
      );
      return { status: 'ok', requests };
    }
    default:
      throw new Error(`Unsupported approval action: ${input.action}`);
  }
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();
  const inputPath = pathResolver.rootResolve(argv.input as string);
  const input = JSON.parse(safeReadFile(inputPath, { encoding: 'utf8' }) as string) as ApprovalAction;
  const result = await handleAction(input);
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err: any) => {
    logger.error(err.message);
    process.exit(1);
  });
}
