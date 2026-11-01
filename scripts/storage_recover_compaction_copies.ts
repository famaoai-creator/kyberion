/**
 * `pnpm kyberion storage recover-compaction-copies` — operator recovery for
 * leftover `.compacting-*` copies of failed parked rewrites (ops-health
 * `stale_compaction_copy`). While a copy exists, parked-aware readers re-read
 * it on every call and agent-input-queue compaction stays skipped.
 *
 * Dry-run by default: lists the stale copies per store (park order, sizes,
 * age) and what a merge would do. Applying needs an authenticated human
 * approval bound to the exact store/copy set; the approval is used once.
 * Under each store's write-time maintenance lock the copies (park order) and
 * then the live file are merged back through the race-safe parked rewrite,
 * dropping lines byte-identical to one kept from an earlier file, and the
 * copies are removed. A store with a copy younger than an hour is refused (it
 * may belong to a rewrite still running). Every merge writes a
 * RETENTION_RECOVER audit record and the run is recorded on the audit chain.
 *
 *   pnpm kyberion storage recover-compaction-copies [--path <store.jsonl>]
 *   pnpm kyberion storage recover-compaction-copies [--path <store.jsonl>] --request-approval [--requested-by <actor>]
 *   pnpm kyberion approvals --approve <id>
 *   pnpm kyberion storage recover-compaction-copies [--path <store.jsonl>] --apply --approval-request-id <id>
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
import { withExecutionContext } from '@agent/core/governance';
import {
  planCompactionCopyRecovery,
  recoverCompactionCopies,
  RECOVER_COMPACTION_COPIES_COMMAND,
  type CompactionCopyLocation,
  type CompactionCopyRecoveryResult,
  type CompactionCopyStorePlan,
} from '@agent/core/compaction-copy-recovery';
import { createStandardYargs } from '@agent/core/cli-utils';
import { cliApprovalRequester } from './lib/cli-approval-requester.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export const RECOVER_COPIES_APPROVAL_CHANNEL = 'terminal';
export const RECOVER_COPIES_EFFECT_BINDING = 'storage:recover-compaction-copies';
/**
 * Writes every store root (runtime, observability AND mission directories —
 * the janitor's ecosystem_architect cannot write the latter two), the store
 * locks and the retention audit log.
 */
const RECOVER_ROLE = 'mission_controller';
const APPROVAL_ROLE = 'mission_controller';
const USAGE = `Usage: ${RECOVER_COMPACTION_COPIES_COMMAND} [--path <store.jsonl>] [--request-approval [--requested-by <actor>]] [--apply --approval-request-id <id>]`;

export interface RecoverCopiesInput extends CompactionCopyLocation {
  /** Only this store (default: every store with copies under the store roots). */
  storePath?: string;
  now?: Date;
}

function planFor(input: RecoverCopiesInput): CompactionCopyStorePlan[] {
  return planCompactionCopyRecovery({
    ...(input.rootDir ? { rootDir: input.rootDir } : {}),
    ...(input.roots ? { roots: input.roots } : {}),
    ...(input.storePath ? { storePath: input.storePath } : {}),
    now: input.now,
  });
}

/** Stores an apply would merge; throws when any selected store is refused or nothing is left. */
function mergeablePlans(plans: CompactionCopyStorePlan[]): CompactionCopyStorePlan[] {
  const withCopies = plans.filter((plan) => plan.copies.length > 0);
  if (withCopies.length === 0) {
    throw new Error('[COMPACTION_COPY_RECOVERY] no compaction copies to recover');
  }
  const refused = withCopies.filter((plan) => plan.action !== 'merge');
  if (refused.length > 0) {
    throw new Error(
      `[COMPACTION_COPY_RECOVERY] refused — ${refused.map((plan) => `${plan.store}: ${plan.detail}`).join('; ')} | next: retry later, or narrow with --path`
    );
  }
  return withCopies;
}

/** The approval binds the exact store/copy set, not the live content, which moves with every append. */
export function recoverCopiesPayloadHash(plans: CompactionCopyStorePlan[]): string {
  return computeApprovalPayloadHash({
    effect: RECOVER_COPIES_EFFECT_BINDING,
    stores: plans
      .map((plan) => ({ store: plan.store, copies: plan.copies.map((copy) => copy.path).sort() }))
      .sort((a, b) => (a.store < b.store ? -1 : a.store > b.store ? 1 : 0)),
  });
}

function correlationIdFor(payloadHash: string): string {
  return `storage-recover-compaction-copies:${payloadHash}`;
}

export interface OpenRecoverCopiesApprovalResult {
  created: boolean;
  requestId: string;
  payloadHash: string;
  plans: CompactionCopyStorePlan[];
}

export function openRecoverCopiesApproval(
  input: RecoverCopiesInput & { requester?: ApprovalRequesterInput }
): OpenRecoverCopiesApprovalResult {
  const plans = mergeablePlans(planFor(input));
  const payloadHash = recoverCopiesPayloadHash(plans);
  const correlationId = correlationIdFor(payloadHash);
  const copyCount = plans.reduce((sum, plan) => sum + plan.copies.length, 0);
  return withExecutionContext(APPROVAL_ROLE, () => {
    const existing = listApprovalRequests({
      storageChannels: [RECOVER_COPIES_APPROVAL_CHANNEL],
      kind: 'mission_gate',
      status: 'pending',
    }).find((record) => record.correlationId === correlationId);
    if (existing) return { created: false, requestId: existing.id, payloadHash, plans };
    const requester = input.requester
      ? resolveApprovalRequesterInput(input.requester)
      : { requestedBy: 'storage-operator' };
    const record = createApprovalRequest(APPROVAL_ROLE, {
      channel: RECOVER_COPIES_APPROVAL_CHANNEL,
      storageChannel: RECOVER_COPIES_APPROVAL_CHANNEL,
      threadTs: correlationId,
      correlationId,
      requestedBy: requester.requestedBy,
      ...(requester.displayName ? { requestedByDisplayName: requester.displayName } : {}),
      kind: 'mission_gate',
      draft: {
        title: `Recover ${copyCount} leftover compaction copy(ies) in ${plans.length} store(s)`,
        summary: `Merge each copy (park order) and then the live file back into the store under its lock, dropping lines identical to one kept from an earlier file, then remove the copies: ${plans.map((plan) => plan.store).join(', ')}.`,
        details: JSON.stringify(plans, null, 2),
        severity: 'medium',
      },
      requestedByContext: {
        surface: 'terminal',
        actorId: approvalRequesterActorId(requester),
        actorRole: APPROVAL_ROLE,
      },
      justification: {
        reason:
          'A failed parked rewrite left .compacting-* copies; parked-aware readers re-read them on every call and agent-input-queue compaction stays skipped until they are merged back.',
        impactSummary:
          'No record is dropped except byte-identical cross-file duplicates; the copies are removed only after the merged store is published.',
        requestedEffects: [RECOVER_COPIES_EFFECT_BINDING],
      },
      risk: {
        level: 'medium',
        restartScope: 'manual',
        requiresStrongAuth: true,
        policyId: 'storage-recover-compaction-copies',
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
        effectBinding: RECOVER_COPIES_EFFECT_BINDING,
      },
    });
    return { created: true, requestId: record.id, payloadHash, plans };
  });
}

/**
 * Binding, human and authentication checks on one approval record. Run on the
 * pre-lock load (fail fast) and again on the record read under its lock right
 * before it is consumed.
 */
export function checkRecoverCopiesApprovalRecord(
  approval: ApprovalRequestRecord | null | undefined,
  plans: CompactionCopyStorePlan[],
  approvalRequestId: string
): { approval: ApprovalRequestRecord; humanDecider: string } {
  if (!approval || approval.kind !== 'mission_gate' || approval.status !== 'approved') {
    throw new Error(
      `[POLICY_VIOLATION] recover-compaction-copies requires an approved request: ${approvalRequestId}`
    );
  }
  if (approval.accountability?.effectBinding !== RECOVER_COPIES_EFFECT_BINDING) {
    throw new Error(
      '[POLICY_VIOLATION] approval is not bound to the recover-compaction-copies effect'
    );
  }
  if (approval.accountability?.payloadHash !== recoverCopiesPayloadHash(plans)) {
    throw new Error(
      '[POLICY_VIOLATION] approval is bound to a different store/copy set — re-run the dry-run and request a new approval'
    );
  }
  const humanApproval = approval.workflow?.approvals?.find(
    (entry) =>
      entry.status === 'approved' && entry.decidedByType === 'human' && entry.authenticated === true
  );
  if (!humanApproval) {
    throw new Error(
      '[POLICY_VIOLATION] recover-compaction-copies requires an authenticated human approval'
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

function loadRecoverApproval(approvalRequestId: string): ApprovalRequestRecord | null {
  return withExecutionContext(APPROVAL_ROLE, () =>
    loadApprovalRequest(RECOVER_COPIES_APPROVAL_CHANNEL, approvalRequestId)
  );
}

export interface RecoverCopiesReceipt {
  mode: 'dry-run' | 'apply';
  plans?: CompactionCopyStorePlan[];
  results?: CompactionCopyRecoveryResult[];
  approval_request_id?: string;
  approved_by?: string;
  next?: string;
}

export async function runRecoverCompactionCopies(
  input: RecoverCopiesInput & { apply?: boolean; approvalRequestId?: string }
): Promise<RecoverCopiesReceipt> {
  const plans = planFor(input);
  if (!input.apply) {
    const pathArg = input.storePath ? ` --path ${input.storePath}` : '';
    return {
      mode: 'dry-run',
      plans,
      next: plans.some((plan) => plan.action === 'merge')
        ? `${RECOVER_COMPACTION_COPIES_COMMAND}${pathArg} --request-approval, then --apply --approval-request-id <id> once approved`
        : 'nothing to recover now',
    };
  }
  if (!input.approvalRequestId) throw new Error('--approval-request-id is required with --apply');
  const approvalRequestId = input.approvalRequestId;
  const selected = mergeablePlans(plans);
  const checked = checkRecoverCopiesApprovalRecord(
    loadRecoverApproval(approvalRequestId),
    selected,
    approvalRequestId
  );
  const results = withExecutionContext(APPROVAL_ROLE, () =>
    consumeApprovalWithin(
      APPROVAL_ROLE,
      {
        channel: RECOVER_COPIES_APPROVAL_CHANNEL,
        requestId: checked.approval.id,
        consumer: 'storage_recover_compaction_copies',
        consumedBy: checked.humanDecider,
        effectRef: selected.map((plan) => plan.store).join(','),
      },
      (consume) => {
        // Re-check the record as it stands under its lock: a decision
        // changed after the first load must not be consumed.
        checkRecoverCopiesApprovalRecord(
          loadRecoverApproval(approvalRequestId),
          selected,
          approvalRequestId
        );
        // Consume before the effect: a failed recovery needs a new approval.
        consume();
        // Each store re-checks its copy set and their age under its own lock.
        return withExecutionContext(RECOVER_ROLE, () =>
          selected.map((plan) =>
            recoverCompactionCopies(
              plan.store,
              plan.copies.map((copy) => copy.path),
              {
                ...(input.rootDir ? { rootDir: input.rootDir } : {}),
                ...(input.roots ? { roots: input.roots } : {}),
                now: input.now,
              }
            )
          )
        );
      }
    )
  );
  auditChain.record({
    agentId: RECOVER_ROLE,
    action: 'storage.recover_compaction_copies',
    operation: `recover:${selected.map((plan) => plan.store).join(',')}`,
    result: results.every((result) => result.outcome === 'merged') ? 'completed' : 'failed',
    reason: `operator compaction-copy recovery approved by ${checked.humanDecider}`,
    correlationId: checked.approval.id,
    metadata: {
      approval_request_id: checked.approval.id,
      approved_by: checked.humanDecider,
      results: results.map((result) => ({
        store: result.store,
        outcome: result.outcome,
        copies: result.copies,
        duplicates_dropped: result.duplicates_dropped,
      })),
    },
  });
  return {
    mode: 'apply',
    results,
    approval_request_id: checked.approval.id,
    approved_by: checked.humanDecider,
  };
}

export async function main(args: string[] = []): Promise<{ result: unknown; failed: boolean }> {
  const argv = await createStandardYargs(['node', 'storage_recover_compaction_copies', ...args])
    .usage(USAGE)
    .option('path', {
      type: 'string',
      describe: 'Only this store (.jsonl under active/shared/runtime, observability or missions)',
    })
    .option('request-approval', { type: 'boolean', default: false })
    .option('requested-by', { type: 'string' })
    .option('apply', { type: 'boolean', default: false, describe: 'Merge (needs an approval)' })
    .option('approval-request-id', { type: 'string' })
    .parseSync();
  const input: RecoverCopiesInput = argv.path ? { storePath: String(argv.path) } : {};
  if (argv['request-approval']) {
    const requestedBy = argv['requested-by'] ? String(argv['requested-by']) : undefined;
    const result = openRecoverCopiesApproval({
      ...input,
      requester: cliApprovalRequester(requestedBy, 'storage-operator'),
    });
    return { result, failed: false };
  }
  const result = await runRecoverCompactionCopies({
    ...input,
    apply: argv.apply === true,
    ...(argv['approval-request-id']
      ? { approvalRequestId: String(argv['approval-request-id']) }
      : {}),
  });
  return {
    result,
    failed: (result.results ?? []).some((entry) => entry.outcome !== 'merged'),
  };
}

export const runRecoverCompactionCopiesCli = defineScript({
  name: 'storage:recover-compaction-copies',
  flags: [],
  run: async (context) => {
    const outcome = await main(context.argv);
    context.print(outcome.result);
    if (outcome.failed) throw new ScriptExitError(1, '', true);
    return outcome.result;
  },
});

if (
  isDirectScript(import.meta.url, 'storage_recover_compaction_copies.ts') ||
  isDirectScript(import.meta.url, 'storage_recover_compaction_copies.js')
)
  void runRecoverCompactionCopiesCli();
