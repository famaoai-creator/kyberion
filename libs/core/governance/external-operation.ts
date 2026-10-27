/** Shared external-effect admission and outcome boundary. Authority is supplied
 * by the embedding caller, never read from actuator params or model output. */
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { normalizeEventScope, type EventScopeInput } from '../event-scope.js';
import { enforceApprovalGate, type ApprovalGateResult } from './approval-gate.js';
import type { ApprovalGateCharterInput } from './approval-gate-charter.js';
import { computeApprovalPayloadHash } from './approval-store.js';
import { auditChain } from './audit-chain.js';
import { createLogger } from '../logger.js';
import {
  recordCharterExecutionOutcome,
  recordCharterExecutionStarted,
  findActiveCharter,
  loadCharterUsage,
} from './accountability-charter-registry.js';
import { reserveExternalOperation } from './external-operation-store.js';
import type { Charter } from './accountability-charter.js';
import type { ApprovalRequesterContext } from './approval-store.js';
import {
  currentDelegatedExecution,
  hasDelegatedExecutionContext,
  delegatedExecutionIdentity,
} from './delegated-execution.js';
import { currentHumanExecutionAuthorization, hasHumanExecutionContext } from './human-execution.js';
import {
  currentOperationInterface,
  defaultOperationInterface,
  evaluateOperationArguments,
  type OperationInterfaceBinding,
} from './operation-protection.js';
export {
  operationInterfaceResolver,
  withOperationArgumentOrigins,
  withOperationInterface,
} from './operation-protection.js';
export type { OperationArgumentOrigin, OperationInterfaceBinding } from './operation-protection.js';
import {
  buildExternalOperationTarget,
  parseExternalOperationGrant,
  externalOperationGrantMatches,
} from './external-operation-target.js';
import { remoteMcpBindingForEffect } from './remote-mcp-interface.js';
import {
  captureExternalApprovalProof,
  verifyExternalOperationCommitProof,
  type ExternalOperationCommitProof,
} from './external-operation-proof.js';
export {
  withTrustedRemoteMcpInterface,
  describeRemoteMcpInterface,
  remoteMcpServerDigest,
} from './remote-mcp-interface.js';
export type {
  RemoteMcpInterfaceBinding,
  RemoteMcpServer,
  RemoteMcpTool,
} from './remote-mcp-interface.js';

const logger = createLogger('external-operation');
type ExternalOperationFacts = Pick<
  ExternalOperation,
  'operationId' | 'effect' | 'requiresApproval' | 'delegable' | 'tenantSlug'
>;
export type ExternalOperationAuthorityResolver = (
  facts: ExternalOperationFacts
) => ExternalOperationAuthority | undefined;
const authorityContext = new AsyncLocalStorage<ExternalOperationAuthorityResolver>();
const invocationAttempts = new AsyncLocalStorage<{ operationId: string; attemptId: string }>();
/** Host-selected, separately approved attempt identity. It grants no permission
 * and affects only the named operation, never a pending downstream tool call. */
export function withExternalOperationInvocationAttempt<T>(
  operationId: string,
  attemptId: string,
  body: () => T
): T {
  if (!attemptId.trim() || attemptId.length > 128)
    throw new Error('[EXTERNAL_ATTEMPT_INVALID] Bounded nonempty host attempt identity required');
  return invocationAttempts.run({ operationId, attemptId }, body);
}
const explicitRequestContext = new AsyncLocalStorage<{
  operationId: string;
  reviewArtifacts: (effect: Record<string, unknown>) => string[];
  requestScope?: EventScopeInput;
}>();

/** Host-only opt-in to enqueue a decision even without an interactive human.
 * Action data cannot enable this, and other operations retain headless behavior. */
export function withExplicitExternalApprovalRequest<T>(
  request: {
    operationId: string;
    reviewArtifacts: (effect: Record<string, unknown>) => string[];
    requestScope?: EventScopeInput;
  },
  body: () => T
): T {
  return explicitRequestContext.run(
    {
      ...request,
      ...(request.requestScope ? { requestScope: normalizeEventScope(request.requestScope) } : {}),
    },
    body
  );
}
/** True when a trusted host already produces governed review artifacts for this
 * operation, so authority resolvers must not duplicate that store write under a
 * caller ambient identity. */
export function hasExplicitExternalApprovalRequest(operationId: string): boolean {
  return explicitRequestContext.getStore()?.operationId === operationId;
}
const pipelineRunContext = new AsyncLocalStorage<string>();

/** Trusted outer checkpoint boundary; never supplied by an action envelope. */
export function withExternalOperationPipelineRun<T>(runId: string, body: () => T): T {
  return pipelineRunContext.run(runId, body);
}

/** A resumable operation must not regenerate random identity after approval. */
export function assertExternalOperationReplayIdentity(stable: boolean, message: string): void {
  if (pipelineRunContext.getStore() && !stable) {
    stopExternalGovernance(`[EXTERNAL_REPLAY_IDENTITY_REQUIRED] ${message}`);
  }
}

/** Inner envelopes have no durable checkpoints; use separate outer steps. */
export function assertExternalOperationBatchResumable(
  externalEffects: number | (() => number)
): void {
  if (
    pipelineRunContext.getStore() &&
    (typeof externalEffects === 'function' ? externalEffects() : externalEffects) > 1
  ) {
    stopExternalGovernance(
      '[EXTERNAL_BATCH_CHECKPOINT_REQUIRED] Split external effects into separate pipeline steps before execution'
    );
  }
}
export interface ExternalOperationApprovalBlock {
  approval: ApprovalGateResult;
  correlationId: string;
  channel: 'external-operation';
}
const approvalBlockContext = new AsyncLocalStorage<
  (block: ExternalOperationApprovalBlock) => void
>();

/** Observe admission blocks even when an actuator SDK returns them as failures. */
export function withExternalOperationApprovalObserver<T>(
  observer: (block: ExternalOperationApprovalBlock) => void,
  body: () => T
): T {
  return approvalBlockContext.run(observer, body);
}
/** One host-handled pending decision may continue in the SAME connected
 * process. The callback is not approval: full admission runs again. */
export async function continueExternalOperationApproval<T>(
  execute: () => Promise<T>,
  wait: ((block: ExternalOperationApprovalBlock) => Promise<void>) | undefined
): Promise<T> {
  if (!wait) return execute();
  const parent = approvalBlockContext.getStore();
  let observed: ExternalOperationApprovalBlock | undefined;
  try {
    return await approvalBlockContext.run(
      (block) => {
        observed = block;
      },
      async () => {
        try {
          return await execute();
        } catch (error) {
          if (
            !(error instanceof ExternalOperationApprovalRequired) ||
            !observed?.approval.requestId ||
            !['created', 'pending'].includes(observed.approval.requestStatus ?? '')
          )
            throw error;
          await wait(observed);
          observed = undefined;
          return execute();
        }
      }
    );
  } catch (error) {
    if (observed) parent?.(observed);
    throw error;
  }
}
const admittedOperations = new WeakMap<
  ExternalOperation,
  {
    authority?: ExternalOperationAuthority;
    operationId: string;
    effectHash: string;
    protectionHash: string;
    proof?: ExternalOperationCommitProof;
    committed?: boolean;
  }
>();

/** Install authority at a trusted runtime boundary, never through action JSON. */
export function withExternalOperationAuthority<T>(
  resolver: ExternalOperationAuthorityResolver,
  body: () => T
): T {
  return authorityContext.run(resolver, body);
}
export function hasExternalOperationAuthority(): boolean {
  return authorityContext.getStore() !== undefined;
}
const admissions = new WeakMap<
  ExternalOperation,
  {
    charter: Charter;
    action: ApprovalGateCharterInput['action'];
    correlationId: string;
    effectHash: string;
    operationId: string;
    pathOptions: ApprovalGateCharterInput['pathOptions'];
  }
>();

export interface ExternalOperationAuthority {
  agentId: string;
  tenantSlug?: string;
  /** A fresh invocation id. Reuse only while resuming this exact effect. */
  invocationId: string;
  hasHuman?: boolean;
  charter?: ApprovalGateCharterInput;
  /** Trusted stop scope survives a target mismatch or an ineligible operation. */
  standingScope?: Charter['scope'];
  /** Trusted production pipeline binding, never copied from effect params. */
  pipelineContext?: ApprovalRequesterContext;
  /** Human-readable, trusted review material; never copy raw effect bodies here. */
  review?: { summary: string; artifactRefs?: string[] };
}

export interface ExternalOperation {
  operationId: string;
  /** Tenant resolved by the actuator boundary, never from authority claims. */
  tenantSlug?: string;
  /** Hash material only; raw content is never persisted in the approval/audit record. */
  effect: Record<string, unknown>;
  /** Reads/local transformations remain automatic; unknown effects require admission. */
  requiresApproval: boolean;
  /** Opaque commands, auth changes and destructive actions cannot delegate. */
  delegable?: boolean;
  /** Existing policy floor, supplied by the typed boundary, never action JSON.
   * Resolved in the same approval request so it preserves assurance/dual-key
   * rules without asking for two independent decisions. */
  approvalPolicy?: { intentId: string; scope: 'governance' | 'policy' | 'review_gate' };
  authority?: ExternalOperationAuthority;
  /** Trusted typed boundary resolver, never deserialized from effect/action JSON. */
  interface?: () => OperationInterfaceBinding;
  /** Additional reviewed argument paths requiring user/policy origins or exact approval. */
  protectedArguments?: string[][];
}

function protectionFor(input: ExternalOperation) {
  const transport = input.interface?.() ?? defaultOperationInterface(input.operationId);
  const runtime = currentOperationInterface();
  let binding =
    transport && runtime
      ? {
          tool: runtime.tool,
          schema_digest: computeApprovalPayloadHash({
            transport: transport.schema_digest,
            runtime: runtime.schema_digest,
          }),
          capability_digest: computeApprovalPayloadHash({
            transport: transport.capability_digest,
            runtime: runtime.capability_digest,
          }),
          candidate_set: [
            ...new Set([...runtime.candidate_set, ...transport.candidate_set]),
          ].sort(),
        }
      : (transport ?? runtime);
  const remote = input.requiresApproval
    ? remoteMcpBindingForEffect(input.operationId, input.effect)
    : undefined;
  if (remote)
    binding = {
      tool: remote.tool,
      schema_digest: computeApprovalPayloadHash({
        local: binding?.schema_digest,
        remote: remote.schema_digest,
      }),
      capability_digest: computeApprovalPayloadHash({
        local: binding?.capability_digest,
        remote: remote.capability_digest,
      }),
      candidate_set: remote.candidate_set,
    };
  if (!binding && input.requiresApproval)
    throw new Error(
      '[OP_INTERFACE_UNAVAILABLE] Executing effects require a live trusted interface resolver'
    );
  const effectiveBinding = binding ?? {
    tool: input.operationId,
    schema_digest: computeApprovalPayloadHash({ boundary: 'read-only.v1' }),
    capability_digest: computeApprovalPayloadHash({ boundary: 'read-only.v1' }),
    candidate_set: [input.operationId],
  };
  const argumentsCheck = evaluateOperationArguments(
    input.operationId,
    input.effect,
    input.protectedArguments
  );
  return {
    binding: effectiveBinding,
    argumentsCheck,
    hash: computeApprovalPayloadHash({
      binding: effectiveBinding,
      evidence: argumentsCheck.evidence_digest,
      tenant: input.tenantSlug,
      runtime_scope: currentScopeEnvelope()
        ? { identity: currentScopeEnvelope()!.identity, policy: currentScopeEnvelope()!.policy }
        : null,
    }),
  };
}

/** Detect mutation, interface drift and revoked ancestry at the actual commit point. */
export function assertExternalOperationCommit(input: ExternalOperation): void {
  const admitted = admittedOperations.get(input);
  if (!admitted) stopExternalGovernance('[EXTERNAL_ADMISSION_REQUIRED] No current admission');
  if (admitted.committed)
    stopExternalGovernance('[EXTERNAL_COMMIT_ALREADY_USED] An admission permits one commit only');
  let current: ReturnType<typeof protectionFor>;
  try {
    current = protectionFor(input);
  } catch {
    admittedOperations.delete(input);
    admissions.delete(input);
    stopExternalGovernance(
      '[EXTERNAL_PROTECTION_CHANGED] Argument source or interface is no longer valid'
    );
  }
  if (
    admitted.operationId !== input.operationId ||
    admitted.effectHash !== computeApprovalPayloadHash(input.effect) ||
    admitted.protectionHash !== current.hash
  ) {
    admittedOperations.delete(input);
    admissions.delete(input);
    stopExternalGovernance(
      '[EXTERNAL_PROTECTION_CHANGED] Effect, interface or argument evidence changed after admission'
    );
  }
  currentServiceExecutionProof(input);
  if (admitted.proof) {
    try {
      verifyExternalOperationCommitProof(admitted.proof);
    } catch (error) {
      admittedOperations.delete(input);
      admissions.delete(input);
      stopExternalGovernance(
        error instanceof Error
          ? error.message
          : '[EXTERNAL_AUTHORITY_CHANGED] Commit proof unavailable'
      );
    }
  }
  admitted.committed = true;
}

export class ExternalOperationApprovalRequired extends Error {
  readonly adfControlFlow = 'preflight';
  constructor(readonly approval: ApprovalGateResult) {
    super(
      `[EXTERNAL_APPROVAL_REQUIRED] ${approval.message ?? 'External operation requires approval'}${approval.requestId ? ` | approval: ${approval.requestId}` : ''}`
    );
  }
}

/** An effect was attempted. Verification, not contract repair, is next. */
export class ExternalOperationOutcomeUnverified extends Error {
  readonly adfControlFlow = 'preflight';
  constructor(cause: unknown) {
    super(
      `[EXTERNAL_RESULT_UNVERIFIED] ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }
}

function signalExternalOutcomeStop(input: Pick<ExternalOperation, 'operationId'>): void {
  approvalBlockContext.getStore()?.({
    approval: {
      allowed: false,
      status: 'pending',
      message: `[EXTERNAL_RESULT_UNVERIFIED] Verify ${input.operationId} before a new invocation; do not repair or replay the attempted effect`,
    },
    correlationId: `external:${randomUUID()}`,
    channel: 'external-operation',
  });
}

/** A receipt exists but a later poll/download/persistence step failed. Keep
 * that continuation from being repaired into another external submission. */
export function stopExternalOperationForVerification(operationId: string, cause: unknown): never {
  signalExternalOutcomeStop({ operationId });
  throw new ExternalOperationOutcomeUnverified(cause);
}

function stopExternalGovernance(
  message: string,
  correlationId = `external:${randomUUID()}`
): never {
  const approval: ApprovalGateResult = { allowed: false, status: 'pending', message };
  approvalBlockContext.getStore()?.({ approval, correlationId, channel: 'external-operation' });
  throw new ExternalOperationApprovalRequired(approval);
}

/** Bridge only the real service effect shape to main's exact, currently
 * verified execution context. JSON assertions never count as proof. */
function currentServiceExecutionProof(input: ExternalOperation) {
  if (!input.operationId.startsWith('service:')) return;
  const effect = input.effect;
  if (
    effect.mode !== 'PRESET' ||
    typeof effect.service_id !== 'string' ||
    typeof effect.action !== 'string' ||
    input.operationId !== `service:${effect.service_id}:preset:${effect.action}`
  ) {
    if (hasDelegatedExecutionContext() || hasHumanExecutionContext()) {
      stopExternalGovernance(
        '[EXTERNAL_EXECUTION_PROOF_MISMATCH] Service effect differs from the active execution authorization'
      );
    }
    return;
  }
  const operation = `service:preset:${effect.service_id}:${effect.action}`;
  const params = {
    request: effect.params,
    auth: effect.auth === 'secret-guard' ? 'secret-guard' : 'none',
  };
  const human = currentHumanExecutionAuthorization(operation, params);
  const delegated = currentDelegatedExecution(operation, params);
  if ((hasHumanExecutionContext() && !human) || (hasDelegatedExecutionContext() && !delegated)) {
    stopExternalGovernance(
      '[EXTERNAL_EXECUTION_PROOF_MISMATCH] Existing service authorization is mismatched, revoked or expired'
    );
  }
  if (human)
    return {
      kind: 'human' as const,
      target: human.target,
      reference: `${human.reference.channel}:${human.reference.requestId}:${human.reference.claimId}`,
    };
  if (delegated)
    return {
      kind: 'delegated' as const,
      target: delegated.target,
      reference: delegated.permitId,
    };
}

export function admitExternalOperation(input: ExternalOperation): ApprovalGateResult {
  admissions.delete(input);
  admittedOperations.delete(input);
  let protection: ReturnType<typeof protectionFor>;
  try {
    protection = protectionFor(input);
  } catch {
    stopExternalGovernance(
      '[EXTERNAL_PROTECTION_UNAVAILABLE] Cannot verify current interface or argument sources'
    );
  }
  const resolved =
    input.authority ??
    authorityContext.getStore()?.({
      operationId: input.operationId,
      effect: input.effect,
      requiresApproval: input.requiresApproval,
      delegable: input.delegable,
      tenantSlug: input.tenantSlug,
    });
  const serviceProof = currentServiceExecutionProof(input);
  if (
    serviceProof &&
    resolved?.tenantSlug &&
    resolved.tenantSlug !== serviceProof.target.tenantSlug
  ) {
    stopExternalGovernance(
      '[EXTERNAL_SCOPE_MISMATCH] Existing execution proof and supplied authority must share a tenant'
    );
  }
  const authority: ExternalOperationAuthority | undefined = serviceProof
    ? {
        agentId: serviceProof.target.agentId,
        tenantSlug: serviceProof.target.tenantSlug,
        invocationId: `main-service:${delegatedExecutionIdentity(serviceProof.target)}`,
        hasHuman: false,
      }
    : resolved
      ? structuredClone(resolved)
      : undefined;
  const attempt = invocationAttempts.getStore();
  if (authority && attempt?.operationId === input.operationId)
    authority.invocationId = computeApprovalPayloadHash({
      base: authority.invocationId,
      attempt: attempt.attemptId,
    });
  if (authority && input.tenantSlug && authority.tenantSlug !== input.tenantSlug) {
    stopExternalGovernance(
      '[EXTERNAL_SCOPE_MISMATCH] Authority must match the boundary tenant binding'
    );
  }
  const envelope = currentScopeEnvelope();
  if (envelope?.policy?.external_egress === 'deny')
    stopExternalGovernance('[EXTERNAL_EGRESS_DENIED] Scope envelope prohibits external egress');
  if (authority && envelope && authority.tenantSlug !== envelope.identity.tenant_slug) {
    stopExternalGovernance(
      '[EXTERNAL_SCOPE_MISMATCH] Authority must match the active scope envelope'
    );
  }
  const effectHash = computeApprovalPayloadHash(input.effect);
  if (!input.requiresApproval) {
    admittedOperations.set(input, {
      authority,
      operationId: input.operationId,
      effectHash,
      protectionHash: protection.hash,
    });
    return { allowed: true, status: 'not_required' };
  }
  if (authority && (!authority.agentId?.trim() || !authority.invocationId?.trim())) {
    stopExternalGovernance(
      '[EXTERNAL_IDENTITY_REQUIRED] Trusted agent and invocation identity are required'
    );
  }
  // Standing tenant stops tighten every external mutation, including opaque
  // human-only operations that cannot obtain delegated authority.
  const trustedTenant = input.tenantSlug ?? authority?.tenantSlug;
  if (
    authority?.standingScope &&
    (authority.standingScope.kind === 'person'
      ? Boolean(trustedTenant)
      : authority.standingScope.tenant_slug !== trustedTenant)
  )
    stopExternalGovernance('[EXTERNAL_SCOPE_MISMATCH] Standing scope differs from boundary scope');
  const standingScope = trustedTenant
    ? { kind: 'organization' as const, tenant_slug: trustedTenant }
    : (authority?.standingScope ??
      (authority?.charter?.scope.kind === 'person' ? authority.charter.scope : undefined));
  if (standingScope) {
    const pathOptions = authority?.charter?.pathOptions;
    let active: Charter | null;
    try {
      active = findActiveCharter(standingScope, new Date(), pathOptions);
    } catch {
      stopExternalGovernance(
        '[EXTERNAL_CHARTER_UNAVAILABLE] Cannot verify the tenant governance state'
      );
    }
    if (active) {
      let standing: string[];
      try {
        standing = loadCharterUsage(active, new Date(), pathOptions).tripwires_hit;
      } catch {
        stopExternalGovernance(
          '[EXTERNAL_CHARTER_UNAVAILABLE] Cannot verify standing tenant tripwires'
        );
      }
      const hit = active.appetite.tripwires.filter((tripwire) => standing.includes(tripwire));
      if (hit.length > 0) {
        stopExternalGovernance(
          `[CHARTER_STOP] ${hit.join(', ')}; only the accountable human can clear this`
        );
      }
    }
  }
  const target = parseExternalOperationGrant(
    buildExternalOperationTarget(input.operationId, input.effect)
  );
  const literalGrant =
    target &&
    authority?.charter?.action.external_operation &&
    externalOperationGrantMatches(authority.charter.action.external_operation, target);
  const needsExactApproval = protection.argumentsCheck.requiresExactApproval && !literalGrant;
  // A broad delegation is not proof of the origin of a new destination.
  if (serviceProof?.kind === 'delegated' && needsExactApproval)
    stopExternalGovernance(
      '[OP_ARGUMENT_AUTHORITY_REQUIRED] Destination needs exact human approval or a verified user/policy origin'
    );
  const declaredCharter = input.delegable ? authority?.charter : undefined;
  if (
    declaredCharter &&
    (declaredCharter.scope.kind === 'person'
      ? Boolean(trustedTenant)
      : !authority?.tenantSlug || declaredCharter.scope.tenant_slug !== authority.tenantSlug)
  ) {
    stopExternalGovernance(
      '[EXTERNAL_SCOPE_MISMATCH] Charter must match the trusted tenant binding'
    );
  }
  const charter = needsExactApproval ? undefined : declaredCharter;
  // Invocation identity prevents one approval becoming a standing grant for
  // identical messages; the effect hash prevents edits while awaiting approval.
  const request = explicitRequestContext.getStore();
  const enqueueRequest = request?.operationId === input.operationId;
  const correlationId = createHash('sha256')
    .update(
      JSON.stringify([
        input.operationId,
        authority?.tenantSlug ?? '',
        authority?.invocationId?.trim() || randomUUID(),
        ...(enqueueRequest ? [effectHash, request?.requestScope ?? null] : []),
      ])
    )
    .digest('hex');
  const artifactRefs = enqueueRequest
    ? request!.reviewArtifacts(structuredClone(input.effect))
    : authority?.review?.artifactRefs;
  const approvalPayload = {
    ...(input.approvalPolicy ? { scope: input.approvalPolicy.scope } : {}),
    effect_hash: effectHash,
    interface_binding: protection.binding,
    argument_evidence_digest: protection.argumentsCheck.evidence_digest,
    rationale:
      authority?.review?.summary ||
      `Review external operation ${input.operationId}${authority?.tenantSlug ? ` for tenant ${authority.tenantSlug}` : ''}`,
    ...(artifactRefs ? { artifact_refs: artifactRefs } : {}),
    ...(authority?.tenantSlug ? { tenant_slug: authority.tenantSlug } : {}),
    ...(charter?.action.decision_type ? { decision_type: charter.action.decision_type } : {}),
  };
  const approval: ApprovalGateResult = serviceProof
    ? {
        allowed: true,
        status: serviceProof.kind === 'human' ? 'approved' : 'not_required',
        message: `Exact existing ${serviceProof.kind} service execution proof`,
      }
    : enforceApprovalGate({
        operationId: input.operationId,
        ...(input.approvalPolicy ? { intentId: input.approvalPolicy.intentId } : {}),
        agentId: authority?.agentId ?? 'external-actuator',
        correlationId: `external:${correlationId}`,
        channel: 'external-operation',
        requireApproval: true,
        // An unbound CLI call never opens prompts or obtains standing delegation.
        hasHuman: authority?.hasHuman ?? false,
        ...(enqueueRequest ? { enqueueRequest: true } : {}),
        ...(enqueueRequest && request?.requestScope ? { requestScope: request.requestScope } : {}),
        ...(charter ? { charter } : {}),
        ...(authority?.pipelineContext
          ? { requestedByContext: authority.pipelineContext, kind: 'mission_gate' as const }
          : {}),
        payload: approvalPayload,
      });
  if (!approval.allowed) {
    approvalBlockContext.getStore()?.({
      approval,
      correlationId: `external:${correlationId}`,
      channel: 'external-operation',
    });
    throw new ExternalOperationApprovalRequired(approval);
  }
  let proof: ExternalOperationCommitProof | undefined;
  if (!serviceProof) {
    if (approval.acceptedCharter && charter)
      proof = {
        kind: 'charter',
        charter: structuredClone(approval.acceptedCharter),
        input: structuredClone(charter),
      };
    else if (approval.requestId) {
      try {
        proof = captureExternalApprovalProof(
          approval.requestId,
          input.operationId,
          computeApprovalPayloadHash(approvalPayload)
        );
      } catch (error) {
        stopExternalGovernance(
          error instanceof Error
            ? error.message
            : '[EXTERNAL_APPROVAL_CHANGED] Approval unavailable'
        );
      }
    } else
      stopExternalGovernance(
        '[EXTERNAL_AUTHORITY_PROOF_REQUIRED] An exact current approval or accepted charter is required'
      );
  }
  // Admit once, then reserve durably before any caller may perform the effect.
  // Pending approvals never reserve. A started reservation is never released:
  // failures/timeouts require verification, not replay with the same identity.
  try {
    reserveExternalOperation({
      tenantSlug: authority?.tenantSlug,
      operationId: input.operationId,
      invocationId: authority?.invocationId?.trim() || correlationId,
      effectHash,
    });
  } catch (error) {
    const conflict =
      error instanceof Error && error.message.includes('EXTERNAL_EXECUTION_ALREADY_RESERVED');
    stopExternalGovernance(
      conflict
        ? input.operationId === 'mcp:connect'
          ? '[MCP_STARTUP_ALREADY_CONSUMED] This stdio startup cannot respawn automatically | next: have the host select a new withMcpStartupAttempt identity and approve that startup separately; the original exact tool approval remains bound to its own unchanged invocation'
          : '[EXTERNAL_EXECUTION_ALREADY_RESERVED] Verify prior execution before any new invocation'
        : '[EXTERNAL_RESERVATION_UNAVAILABLE] Cannot durably reserve execution; verify storage before retrying',
      `external:${correlationId}`
    );
  }
  if (serviceProof) {
    const current = currentServiceExecutionProof(input);
    if (
      !current ||
      current.kind !== serviceProof.kind ||
      current.reference !== serviceProof.reference
    ) {
      stopExternalGovernance(
        '[EXTERNAL_EXECUTION_PROOF_CHANGED] Existing service authorization changed before execution'
      );
    }
    auditChain.record({
      agentId: authority!.agentId,
      action: 'external_operation_admission',
      operation: input.operationId,
      result: 'allowed',
      reason: `Reused exact existing ${serviceProof.kind} execution proof; no new approval or charter consumption`,
      metadata: {
        tenant_slug: authority!.tenantSlug,
        invocation_id: authority!.invocationId,
        effect_hash: effectHash,
        execution_provenance: serviceProof.kind,
        execution_reference: serviceProof.reference,
      },
    });
  }
  if (approval.acceptedCharter && charter) {
    try {
      recordCharterExecutionStarted(
        approval.acceptedCharter,
        {
          actor: charter.action.actor.id,
          action_class: charter.action.action_class,
          operation_id: input.operationId,
          correlation_id: `external:${correlationId}`,
          effect_hash: effectHash,
        },
        charter.pathOptions
      );
    } catch {
      stopExternalGovernance(
        '[EXTERNAL_START_EVIDENCE_UNAVAILABLE] Execution was reserved but start evidence could not be verified; do not rerun',
        `external:${correlationId}`
      );
    }
  }
  admittedOperations.set(input, {
    authority,
    operationId: input.operationId,
    effectHash,
    protectionHash: protection.hash,
    proof,
  });
  if (approval.acceptedCharter && charter) {
    admissions.set(input, {
      charter: structuredClone(approval.acceptedCharter),
      action: structuredClone(charter.action),
      correlationId: `external:${correlationId}`,
      effectHash,
      operationId: input.operationId,
      pathOptions: charter.pathOptions ? { ...charter.pathOptions } : undefined,
    });
  }
  return approval;
}

/** A failed/unknown external result is evidence, never an instruction to retry. */
export async function runExternalOperation<T>(
  input: ExternalOperation,
  execute: () => Promise<T>,
  classify: (result: T) => 'succeeded' | 'failed' | 'unknown'
): Promise<T> {
  admitExternalOperation(input);
  assertExternalOperationCommit(input);
  let result: T;
  try {
    result = await execute();
  } catch (error) {
    recordExternalOperationOutcome(input, 'unknown');
    // Repairing a transport exception may change the operation/destination and
    // bypass a same-invocation reservation. Never repair an attempted mutation.
    if (input.requiresApproval) {
      signalExternalOutcomeStop(input);
      throw new ExternalOperationOutcomeUnverified(error);
    }
    throw error;
  }
  let outcome: 'succeeded' | 'failed' | 'unknown' = 'unknown';
  try {
    outcome = classify(result);
  } catch {
    /* Result already exists; do not retry. */
  }
  recordExternalOperationOutcome(input, outcome);
  // The SDK may turn a failed/partial receipt into an ordinary result envelope.
  // Preserve the verification stop at the trusted outer dispatch boundary.
  if (input.requiresApproval && outcome !== 'succeeded') signalExternalOutcomeStop(input);
  return result;
}

/** Synchronous transports (git/CLI) keep their existing contract and the same
 * admission/reservation/outcome/terminal-observer semantics. */
export function runExternalOperationSync<T>(
  input: ExternalOperation,
  execute: () => T,
  classify: (result: T) => 'succeeded' | 'failed' | 'unknown'
): T {
  admitExternalOperation(input);
  assertExternalOperationCommit(input);
  let result: T;
  try {
    result = execute();
  } catch (error) {
    recordExternalOperationOutcome(input, 'unknown');
    if (input.requiresApproval) {
      signalExternalOutcomeStop(input);
      throw new ExternalOperationOutcomeUnverified(error);
    }
    throw error;
  }
  let outcome: 'succeeded' | 'failed' | 'unknown' = 'unknown';
  try {
    outcome = classify(result);
  } catch {
    /* Attempted effect needs verification. */
  }
  recordExternalOperationOutcome(input, outcome);
  if (input.requiresApproval && outcome !== 'succeeded') signalExternalOutcomeStop(input);
  return result;
}

/** Never throw after the effect: failed telemetry must not cause duplicate sends. */
export function recordExternalOperationOutcome(
  input: ExternalOperation,
  outcome: 'succeeded' | 'failed' | 'unknown'
): void {
  const admitted = admittedOperations.get(input);
  admittedOperations.delete(input);
  if (!admitted) return;
  const admission = admissions.get(input);
  admissions.delete(input);
  if (admission) {
    try {
      recordCharterExecutionOutcome(
        admission.charter,
        {
          actor: admission.action.actor.id,
          action_class: admission.action.action_class,
          operation_id: admission.operationId,
          correlation_id: admission.correlationId,
          effect_hash: admission.effectHash,
          outcome,
        },
        admission.pathOptions
      );
    } catch {
      logger.warn(
        '[CHARTER_OUTCOME_UNRECORDED] Execution outcome not saved | next: verify scoped ledger before retrying'
      );
    }
  }
  try {
    auditChain.record({
      agentId: admitted.authority?.agentId ?? 'external-actuator',
      action: 'external_operation_outcome',
      operation: admitted.operationId,
      result: outcome === 'succeeded' ? 'allowed' : 'denied',
      reason: `External operation ${outcome}; admission is not proof of execution`,
      metadata: {
        outcome,
        tenant_slug: admitted.authority?.tenantSlug,
        invocation_id: admitted.authority?.invocationId,
        effect_hash: admitted.effectHash,
      },
    });
  } catch {
    logger.warn(
      '[EXTERNAL_OUTCOME_UNRECORDED] Effect completed but audit failed | next: inspect audit storage before retrying'
    );
  }
}
