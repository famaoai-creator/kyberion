/**
 * `pnpm kyberion scheduler trigger-store rotate` — operator escape hatch for a
 * trigger delivery journal stuck at its hard append cap ([TRIGGER_STORE_FULL]),
 * which happens only when stable keys inside the 7-day dedupe window alone
 * fill it (libs/core/trigger-runner.ts never drops those on its own).
 *
 * Dry-run by default: prints what a rotation keeps (in-flight claims, the
 * newest N stable keys, cron receipts of the last 10 minutes) and drops.
 * Applying needs an authenticated human approval bound to the store path and
 * N; the approval is used once. The full journal is archived to a segment
 * first, the rewrite runs under the store lock, and the result is recorded on
 * the audit chain. A dropped stable key may re-deliver once.
 *
 *   pnpm kyberion scheduler trigger-store rotate [--keep-stable <n>]
 *   pnpm kyberion scheduler trigger-store rotate --request-approval [--requested-by <actor>]
 *   pnpm kyberion approvals --approve <id>
 *   pnpm kyberion scheduler trigger-store rotate --apply --approval-request-id <id>
 */
import {
  approvalRequesterActorId,
  resolveApprovalRequesterInput,
  type ApprovalRequesterInput,
} from '@agent/core/governance/approval-requester';
import {
  computeApprovalPayloadHash,
  createApprovalRequest,
  listApprovalRequests,
  loadApprovalRequest,
  validateHumanFinalDecision,
  type ApprovalRequestRecord,
} from '@agent/core/governance/approval-store';
import { consumeApprovalWithin } from '@agent/core/governance/approval-revocation';
import { auditChain } from '@agent/core/governance/audit-chain';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/governance';
import {
  planTriggerStoreRotation,
  rotateTriggerStore,
  TRIGGER_STORE_ROTATE_DEFAULT_KEEP_STABLE,
  type TriggerStoreRotationPlan,
  type TriggerStoreRotationResult,
} from '@agent/core/trigger-runner';
import { createStandardYargs } from '@agent/core/cli-utils';
import { cliApprovalRequester } from './lib/cli-approval-requester.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export const TRIGGER_STORE_ROTATE_APPROVAL_CHANNEL = 'terminal';
export const TRIGGER_STORE_ROTATE_EFFECT_BINDING = 'trigger-store:rotate';
/** Writes active/shared/runtime/ (journal + segment); a shared core role. */
const ROTATE_ROLE = 'infrastructure_sentinel';
const APPROVAL_ROLE = 'mission_controller';
const USAGE =
  'Usage: pnpm kyberion scheduler trigger-store rotate [--keep-stable <n>] [--store <path>] [--request-approval [--requested-by <actor>]] [--apply --approval-request-id <id>]';

export interface TriggerStoreRotateInput {
  storePath?: string;
  keepStable?: number;
  now?: Date;
}

/** The approval binds the operation (store + N), not the journal content, which moves every tick. */
export function triggerStoreRotatePayloadHash(plan: TriggerStoreRotationPlan): string {
  return computeApprovalPayloadHash({
    effect: TRIGGER_STORE_ROTATE_EFFECT_BINDING,
    store_path: plan.store_path,
    keep_stable: plan.keep_stable,
  });
}

function correlationIdFor(plan: TriggerStoreRotationPlan): string {
  return `trigger-store-rotate:${plan.store_path}:${plan.keep_stable}`;
}

export interface OpenRotateApprovalResult {
  created: boolean;
  requestId: string;
  payloadHash: string;
  plan: TriggerStoreRotationPlan;
}

export function openTriggerStoreRotateApproval(
  input: TriggerStoreRotateInput & { requester?: ApprovalRequesterInput }
): OpenRotateApprovalResult {
  const plan = planTriggerStoreRotation(input);
  const payloadHash = triggerStoreRotatePayloadHash(plan);
  const correlationId = correlationIdFor(plan);
  return withExecutionContext(APPROVAL_ROLE, () => {
    const existing = listApprovalRequests({
      storageChannels: [TRIGGER_STORE_ROTATE_APPROVAL_CHANNEL],
      kind: 'mission_gate',
      status: 'pending',
    }).find((record) => record.correlationId === correlationId);
    if (existing) return { created: false, requestId: existing.id, payloadHash, plan };
    const requester = input.requester
      ? resolveApprovalRequesterInput(input.requester)
      : { requestedBy: 'trigger-store-operator' };
    const record = createApprovalRequest(APPROVAL_ROLE, {
      channel: TRIGGER_STORE_ROTATE_APPROVAL_CHANNEL,
      storageChannel: TRIGGER_STORE_ROTATE_APPROVAL_CHANNEL,
      threadTs: correlationId,
      correlationId,
      requestedBy: requester.requestedBy,
      ...(requester.displayName ? { requestedByDisplayName: requester.displayName } : {}),
      kind: 'mission_gate',
      draft: {
        title: `Rotate the trigger delivery journal (${plan.store_path})`,
        summary: `Archive the journal to a segment and keep only in-flight claims, the newest ${plan.keep_stable} stable keys and cron receipts of the last 10 minutes. Dropped stable keys may re-deliver once.`,
        details: JSON.stringify(plan, null, 2),
        severity: 'high',
      },
      requestedByContext: {
        surface: 'terminal',
        actorId: approvalRequesterActorId(requester),
        actorRole: APPROVAL_ROLE,
      },
      justification: {
        reason: 'The delivery journal is at its hard append cap; every trigger fails closed.',
        impactSummary: `Full history is kept in a rotated segment; up to ${plan.dropped_keys} key(s) lose dedupe protection.`,
        requestedEffects: [TRIGGER_STORE_ROTATE_EFFECT_BINDING],
      },
      risk: {
        level: 'high',
        restartScope: 'manual',
        requiresStrongAuth: true,
        policyId: 'trigger-store-rotate',
      },
      workflow: {
        workflowId: correlationId,
        mode: 'all_required',
        requiredRoles: ['sovereign'],
        stages: [],
        approvals: [{ role: 'sovereign', status: 'pending' }],
      },
      accountability: {
        finalDecision: 'human_only',
        payloadHash,
        effectBinding: TRIGGER_STORE_ROTATE_EFFECT_BINDING,
      },
    });
    return { created: true, requestId: record.id, payloadHash, plan };
  });
}

function assertRotateApproval(
  approvalRequestId: string,
  plan: TriggerStoreRotationPlan
): { approval: ApprovalRequestRecord; humanDecider: string } {
  const approval = withExecutionContext(APPROVAL_ROLE, () =>
    loadApprovalRequest(TRIGGER_STORE_ROTATE_APPROVAL_CHANNEL, approvalRequestId)
  );
  if (!approval || approval.kind !== 'mission_gate' || approval.status !== 'approved') {
    throw new Error(
      `[POLICY_VIOLATION] trigger-store rotate requires an approved request: ${approvalRequestId}`
    );
  }
  if (approval.accountability?.effectBinding !== TRIGGER_STORE_ROTATE_EFFECT_BINDING) {
    throw new Error('[POLICY_VIOLATION] approval is not bound to the trigger-store rotate effect');
  }
  if (approval.accountability?.payloadHash !== triggerStoreRotatePayloadHash(plan)) {
    throw new Error(
      '[POLICY_VIOLATION] approval is bound to a different store or --keep-stable value'
    );
  }
  const humanApproval = approval.workflow?.approvals?.find(
    (entry) =>
      entry.status === 'approved' && entry.decidedByType === 'human' && entry.authenticated === true
  );
  if (!humanApproval) {
    throw new Error(
      '[POLICY_VIOLATION] trigger-store rotate requires an authenticated human approval'
    );
  }
  validateHumanFinalDecision({
    accountability: approval.accountability,
    decidedByType: humanApproval.decidedByType,
    authenticated: humanApproval.authenticated,
    authMethod: humanApproval.authMethod,
    payloadHash: humanApproval.payloadHash,
    effectBinding: humanApproval.effectBinding,
    phase: 'recheck',
  });
  const humanDecider = humanApproval.approvedBy || approval.decidedBy;
  if (!humanDecider) {
    throw new Error('[POLICY_VIOLATION] approval does not name its human decider');
  }
  return { approval, humanDecider };
}

export interface TriggerStoreRotateReceipt {
  mode: 'dry-run' | 'apply';
  plan?: TriggerStoreRotationPlan;
  result?: TriggerStoreRotationResult;
  approval_request_id?: string;
  approved_by?: string;
  next?: string;
}

export async function runTriggerStoreRotate(
  input: TriggerStoreRotateInput & { apply?: boolean; approvalRequestId?: string }
): Promise<TriggerStoreRotateReceipt> {
  const plan = planTriggerStoreRotation(input);
  if (!input.apply) {
    return {
      mode: 'dry-run',
      plan,
      next: 'pnpm kyberion scheduler trigger-store rotate --request-approval, then --apply --approval-request-id <id> once approved',
    };
  }
  if (!input.approvalRequestId) throw new Error('--approval-request-id is required with --apply');
  const checked = assertRotateApproval(input.approvalRequestId, plan);
  const result = await withExecutionContextAsync(ROTATE_ROLE, () =>
    rotateTriggerStore(input, (effect) =>
      withExecutionContext(APPROVAL_ROLE, () =>
        consumeApprovalWithin(
          APPROVAL_ROLE,
          {
            channel: TRIGGER_STORE_ROTATE_APPROVAL_CHANNEL,
            requestId: checked.approval.id,
            consumer: 'trigger_store_rotate',
            consumedBy: checked.humanDecider,
            effectRef: plan.store_path,
          },
          (consume) => {
            // Consume before the effect: a failed rotation needs a new approval.
            consume();
            return withExecutionContext(ROTATE_ROLE, effect);
          }
        )
      )
    )
  );
  auditChain.record({
    agentId: ROTATE_ROLE,
    action: 'trigger.store_rotate',
    operation: `rotate:${result.store_path}`,
    result: 'completed',
    reason: `operator rotation approved by ${checked.humanDecider}`,
    correlationId: checked.approval.id,
    metadata: {
      approval_request_id: checked.approval.id,
      approved_by: checked.humanDecider,
      segment_path: result.segment_path,
      keep_stable: result.keep_stable,
      kept: result.kept,
      dropped_keys: result.dropped_keys,
      size_bytes_before: result.size_bytes,
      size_bytes_after: result.kept_bytes,
    },
  });
  return {
    mode: 'apply',
    result,
    approval_request_id: checked.approval.id,
    approved_by: checked.humanDecider,
  };
}

export async function main(args: string[] = []): Promise<{ result: unknown; failed: boolean }> {
  const argv = await createStandardYargs(['node', 'trigger_store_rotate', ...args])
    .usage(USAGE)
    .option('store', { type: 'string', describe: 'Delivery journal (default: the live journal)' })
    .option('keep-stable', {
      type: 'number',
      default: TRIGGER_STORE_ROTATE_DEFAULT_KEEP_STABLE,
      describe: 'Newest stable (non-cron) keys to keep',
    })
    .option('request-approval', { type: 'boolean', default: false })
    .option('requested-by', { type: 'string' })
    .option('apply', { type: 'boolean', default: false, describe: 'Rotate (needs an approval)' })
    .option('approval-request-id', { type: 'string' })
    .parseSync();
  const input: TriggerStoreRotateInput = {
    ...(argv.store ? { storePath: String(argv.store) } : {}),
    keepStable: Number(argv['keep-stable']),
  };
  if (argv['request-approval']) {
    const requestedBy = argv['requested-by'] ? String(argv['requested-by']) : undefined;
    const result = openTriggerStoreRotateApproval({
      ...input,
      requester: cliApprovalRequester(requestedBy, 'trigger-store-operator'),
    });
    return { result, failed: false };
  }
  return {
    result: await runTriggerStoreRotate({
      ...input,
      apply: argv.apply === true,
      ...(argv['approval-request-id']
        ? { approvalRequestId: String(argv['approval-request-id']) }
        : {}),
    }),
    failed: false,
  };
}

export const runTriggerStoreRotateCli = defineScript({
  name: 'scheduler:trigger-store-rotate',
  flags: [],
  run: async (context) => {
    const outcome = await main(context.argv);
    context.print(outcome.result);
    if (outcome.failed) throw new ScriptExitError(1, '', true);
    return outcome.result;
  },
});

if (
  isDirectScript(import.meta.url, 'trigger_store_rotate.ts') ||
  isDirectScript(import.meta.url, 'trigger_store_rotate.js')
)
  void runTriggerStoreRotateCli();
