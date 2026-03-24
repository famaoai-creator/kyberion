import {
  createApprovalRequest,
  createStandardYargs,
  decideApprovalRequest,
  listGovernedArtifacts,
  loadApprovalRequest,
  logger,
  safeReadFile,
} from '@agent/core';
import type {
  ApprovalJustification,
  ApprovalRequesterContext,
  ApprovalRequestDraft,
  ApprovalRiskProfile,
  ApprovalTargetDescriptor,
  ApprovalWorkflowState,
  GovernedArtifactRole,
} from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const role = input.params.role || 'mission_controller';
  switch (input.action) {
    case 'create':
      if (!input.params.threadTs || !input.params.correlationId || !input.params.requestedBy || !input.params.draft) {
        throw new Error('threadTs, correlationId, requestedBy, and draft are required');
      }
      return {
        status: 'created',
        request: createApprovalRequest(role, {
          channel: input.params.channel,
          storageChannel: input.params.storageChannel,
          threadTs: input.params.threadTs,
          correlationId: input.params.correlationId,
          requestedBy: input.params.requestedBy,
          draft: input.params.draft,
          sourceText: input.params.sourceText,
          kind: input.params.requestKind,
          expiresAt: input.params.expiresAt,
          requestedByContext: input.params.requestedByContext,
          target: input.params.target,
          justification: input.params.justification,
          risk: input.params.risk,
          workflow: input.params.workflow,
        }),
      };
    case 'load':
      if (!input.params.requestId) throw new Error('requestId is required');
      return {
        status: 'ok',
        request: loadApprovalRequest(input.params.channel, input.params.requestId),
      };
    case 'decide':
      if (!input.params.requestId || !input.params.decision || !input.params.decidedBy) {
        throw new Error('requestId, decision, and decidedBy are required');
      }
      return {
        status: 'ok',
        request: decideApprovalRequest(role, {
          channel: input.params.channel,
          storageChannel: input.params.storageChannel,
          requestId: input.params.requestId,
          decision: input.params.decision,
          decidedBy: input.params.decidedBy,
          decidedByRole: input.params.decidedByRole,
          authMethod: input.params.authMethod,
          note: input.params.note,
        }),
      };
    case 'list_pending': {
      const storageChannel = input.params.storageChannel || input.params.channel;
      const entries = listGovernedArtifacts(`active/shared/coordination/channels/${storageChannel}/approvals/requests`);
      const requests = entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => loadApprovalRequest(storageChannel, entry.replace(/\.json$/, '')))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .filter((entry) => entry.status === 'pending');
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
  const inputPath = path.resolve(process.cwd(), argv.input as string);
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
