/** Synthetic DOT admission eligibility only: no pipeline-effect permission or race-free guarantee. */
import { z } from 'zod';
import type { WorkItem, WorkLease } from '../workforce/work-coordination-types.js';
import { workEffectOwnership } from '../workforce/work-effect-ownership.js';
import type { AutonomousOpsGateResult } from '../governance/autonomous-ops-gate.js';
import {
  isApprovalRequestExpired,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import { judgmentCanonicalHash } from '../organization/judgment-precedents.js';
import {
  latencyProposalFactsSchema,
  latencyGoalConstraintsSchema,
  parseJudgmentModelInput,
  type LatencyProposalFacts,
  type LatencyGoalConstraints,
} from '../organization/judgment-contract.js';
import { checkJudgmentContext } from '../organization/judgment-validation.js';
import {
  readHistoricalJudgmentEvidence,
  resolveLatestJudgmentEvidence,
  reuseJudgmentEvidence,
  type JudgmentEvidenceRequest,
  type JudgmentEvidenceDeps,
  type JudgmentEvidenceReference,
} from '../organization/judgment-evidence.js';
import type { DotCharter } from './dot-charter.js';
import type { DotProposal } from './dot-proposals.js';
import { assertDotActionJudgmentBinding, type DotActionRecord } from './dot-action-ledger.js';
import { assertDotJudgmentProposalCharter } from './dot-admission-identity.js';
import { parseDotJudgmentBinding } from './dot-judgment-binding.js';
import { dotWorkItemInput, assertDotExistingWorkItem } from './dot-work-item.js';
import { requireCurrentDotJudgmentApproval } from './dot-judgment-approval.js';
import { dotActorId, type DotBoundsVerdict } from './dot-dispatch.js';
import { isDotIntakeAdmission, loadDotExecutionPolicy } from './dot-execution-policy.js';

const key = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim());
const selectorSchema = z
  .object({
    mode: z.literal('synthetic_fixture'),
    dot_id: key,
    action_ref: key,
    item_id: key,
    lease_id: key,
    run_id: key,
    expected_item_version: z.number().finite().int().min(1),
  })
  .strict();
export type DotJudgmentPreEffectInput = z.infer<typeof selectorSchema>;
export interface DotJudgmentExecutionState {
  charter: DotCharter;
  action: DotActionRecord;
  item: WorkItem;
  lease: WorkLease | null;
}
export interface TrustedDotJudgmentEffect {
  /** A server-configured exact original-proposal mapping, never inferred from its prose. */
  request: JudgmentEvidenceRequest;
  proposalFacts: LatencyProposalFacts;
  goals: readonly LatencyGoalConstraints[];
}
export interface DotJudgmentPreEffectDeps {
  now(): number;
  /** Existing scoped readers, closed over the real root/namespace and exact selectors. */
  readExecutionState(): DotJudgmentExecutionState;
  resolveTrustedEffect(originalProposal: DotProposal): TrustedDotJudgmentEffect;
  readCurrentContext: JudgmentEvidenceDeps['readCurrentContext'];
  hasRole(role: string): boolean;
  checkBounds(charter: DotCharter, originalProposal: DotProposal): DotBoundsVerdict;
  evaluateGate(charter: DotCharter, originalProposal: DotProposal): AutonomousOpsGateResult;
  readEffectPolicyVersion(): string;
  loadApproval(id: string): ApprovalRequestRecord | null;
}
export type DotJudgmentPreEffectResult =
  | {
      status: 'eligible_observed';
      observed_at: string;
      actor_id: string;
      authority_role: string;
      origin_receipt: NonNullable<DotActionRecord['semantic_judgment']>['origin_receipt'];
      latest_receipt: JudgmentEvidenceReference;
      proposal_facts: LatencyProposalFacts;
      goals: LatencyGoalConstraints[];
      /** Audit comparison only. No executor accepts this as an authorization token. */
      observation_hash: string;
    }
  | { status: 'unavailable'; reason: 'pre_effect_unavailable' };

function immutable<T>(value: T): T {
  judgmentCanonicalHash(value);
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}
function synchronous<T>(value: T): T {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
  ) {
    void Promise.resolve(value).catch(() => undefined);
    throw new Error('Asynchronous read port');
  }
  return value;
}
const orderedGoals = (goals: readonly LatencyGoalConstraints[]) =>
  [...goals].sort((a, b) => a.goal_key.localeCompare(b.goal_key));
function modelHash(raw: unknown): string {
  const input = parseJudgmentModelInput(raw);
  return judgmentCanonicalHash({
    ...input,
    goals: orderedGoals(input.goals),
    precedents: [...input.precedents].sort((a, b) => a.source_key.localeCompare(b.source_key)),
    evidence: [...input.evidence].sort((a, b) => a.evidence_key.localeCompare(b.evidence_key)),
  });
}
function timestamp(raw: string, now: number): number {
  const value = Date.parse(raw);
  if (!Number.isFinite(value) || value > now) throw new Error('Invalid ownership clock');
  return value;
}
function validateState(
  input: DotJudgmentPreEffectInput,
  state: DotJudgmentExecutionState,
  now: number
) {
  const { charter, action, item, lease } = state;
  assertDotActionJudgmentBinding(action);
  const binding = parseDotJudgmentBinding(action.semantic_judgment);
  if (!binding || !lease) throw new Error('Missing judged ownership');
  assertDotJudgmentProposalCharter(charter, action.admission!.proposal);
  const actor = dotActorId(charter.dot_id);
  if (
    charter.dot_id !== input.dot_id ||
    action.dot_id !== input.dot_id ||
    action.actor_id !== actor ||
    action.action_ref !== input.action_ref ||
    action.status !== 'dispatched' ||
    action.work_item_id !== input.item_id ||
    item.item_id !== input.item_id ||
    item.status !== 'in_progress' ||
    item.version !== input.expected_item_version ||
    item.lease_id !== input.lease_id ||
    item.current_attempt_id !== input.run_id ||
    item.claimed_by_peer_id !== actor ||
    lease.lease_id !== input.lease_id ||
    lease.item_id !== item.item_id ||
    lease.holder_peer_id !== actor ||
    lease.status !== 'active' ||
    lease.holder_user_id !== item.claimed_by_user_id ||
    lease.released_at !== undefined ||
    !Number.isFinite(Date.parse(lease.expires_at)) ||
    Date.parse(lease.expires_at) <= now
  )
    throw new Error('Claim, action or current item differs');
  const created = timestamp(lease.created_at, now),
    renewed = timestamp(lease.renewed_at, now);
  if (renewed < created || Date.parse(lease.expires_at) <= renewed)
    throw new Error('Invalid lease lifetime');
  timestamp(item.claimed_at!, now);
  const running = (item.attempts ?? []).filter((attempt) => attempt.status === 'running');
  if (
    running.length !== 1 ||
    running[0].run_id !== input.run_id ||
    running[0].lease_id !== lease.lease_id ||
    running[0].actor_peer_id !== actor ||
    running[0].actor_user_id !== lease.holder_user_id ||
    running[0].ended_at !== undefined
  )
    throw new Error('Current running attempt differs');
  timestamp(running[0].started_at, now);
  for (const field of [
    'tenant_slug',
    'organization_id',
    'project_id',
    'mission_id',
    'task_id',
    'session_id',
  ] as const)
    if ((item.context as Record<string, unknown> | undefined)?.[field] !== binding.scope[field])
      throw new Error('Full item scope differs');
  const expected = dotWorkItemInput(charter, action);
  assertDotExistingWorkItem(action, item, expected, true);
  const ownership = workEffectOwnership(item);
  if (
    ownership &&
    (ownership.state !== 'held' ||
      ownership.attempt_id !== input.run_id ||
      ownership.actor_id !== actor ||
      ownership.tenant_slug !== binding.scope.tenant_slug)
  )
    throw new Error('Held effect owner differs');
  return binding;
}
function mappedEffect(state: DotJudgmentExecutionState, deps: DotJudgmentPreEffectDeps) {
  const value = immutable(synchronous(deps.resolveTrustedEffect(state.action.admission!.proposal)));
  const binding = parseDotJudgmentBinding(state.action.semantic_judgment)!;
  const request = value.request;
  const facts = latencyProposalFactsSchema.parse(value.proposalFacts);
  const goals = value.goals.map((goal) => latencyGoalConstraintsSchema.parse(goal));
  const modelInput = parseJudgmentModelInput(request.context.modelInput);
  if (
    judgmentCanonicalHash(value.proposalFacts) !== judgmentCanonicalHash(facts) ||
    judgmentCanonicalHash(request.context.binding) !==
      judgmentCanonicalHash(binding.judgment_binding) ||
    judgmentCanonicalHash(request.context.scope) !== judgmentCanonicalHash(binding.scope) ||
    request.effectRef !== binding.effect_ref ||
    judgmentCanonicalHash(modelInput.proposal) !== judgmentCanonicalHash(facts) ||
    judgmentCanonicalHash(orderedGoals(goals)) !==
      judgmentCanonicalHash(orderedGoals(modelInput.goals)) ||
    judgmentCanonicalHash(orderedGoals(goals)) !==
      judgmentCanonicalHash(orderedGoals(request.context.snapshot.goals)) ||
    judgmentCanonicalHash([...request.context.requiredGoalKeys].sort()) !==
      judgmentCanonicalHash(goals.map((goal) => goal.goal_key).sort())
  )
    throw new Error('Trusted original facts or goals differ');
  return value;
}
function gateDto(gate: AutonomousOpsGateResult): Record<string, unknown> {
  // Legitimate existing gate results carry optional own undefined values. Omit only those;
  // reject accessors/symbols and retain every other authority field for the final comparison.
  if (!gate || Object.getPrototypeOf(gate) !== Object.prototype)
    throw new Error('Invalid gate DTO prototype');
  const result: Record<string, unknown> = {};
  for (const field of Reflect.ownKeys(gate)) {
    const descriptor = Object.getOwnPropertyDescriptor(gate, field)!;
    if (
      typeof field !== 'string' ||
      field === '__proto__' ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    )
      throw new Error('Lossy gate DTO');
    if (descriptor.value !== undefined) result[field] = descriptor.value;
  }
  judgmentCanonicalHash(result);
  return result;
}
function authority(
  state: DotJudgmentExecutionState,
  deps: DotJudgmentPreEffectDeps,
  now: () => number
) {
  const binding = parseDotJudgmentBinding(state.action.semantic_judgment)!;
  const proposal = state.action.admission!.proposal;
  const role = synchronous(deps.hasRole(state.charter.authority.authority_role));
  const bounds = immutable(synchronous(deps.checkBounds(state.charter, proposal)));
  const policy = key.parse(synchronous(deps.readEffectPolicyVersion()));
  const gate = synchronous(deps.evaluateGate(state.charter, proposal));
  const dto = gateDto(gate);
  const intake = isDotIntakeAdmission(state.charter, proposal);
  const executionPolicy = immutable(loadDotExecutionPolicy());
  const expectedAction = intake ? executionPolicy.intake.action_id : proposal.action_id;
  if (
    role !== true ||
    bounds.ok !== true ||
    policy !== binding.effect_policy_version ||
    gate.policyVersion !== policy ||
    gate.actionId !== expectedAction ||
    (intake
      ? state.action.admission_only !== true || state.action.gate_action_id !== expectedAction
      : state.action.admission_only === true || state.action.gate_action_id !== undefined) ||
    gate.tenantSlug !== binding.scope.tenant_slug ||
    gate.executionMode !== 'apply' ||
    gate.shadow !== false ||
    typeof gate.allowed !== 'boolean' ||
    !Number.isFinite(gate.score) ||
    gate.score < 0 ||
    !Number.isFinite(gate.maxScore) ||
    gate.maxScore < 0 ||
    !['auto', 'notify', 'approve'].includes(gate.decision)
  )
    throw new Error('Current authority unavailable');
  const approval = requireCurrentDotJudgmentApproval(state.charter, state.action, {
    now: () => new Date(now()),
    loadApproval: (id) => synchronous(deps.loadApproval(id)),
  });
  // Current gate contract: finite known-action approve/allowed=false means approval is needed.
  // A future finite hard-refusal form must update this classifier and its regression tests.
  if (gate.decision === 'approve' ? gate.allowed !== false || !approval : gate.allowed !== true)
    throw new Error('Gate or exact approval refuses');
  return immutable({
    role,
    bounds,
    policy,
    execution_policy: { version: executionPolicy.version, intake: executionPolicy.intake },
    gate: dto,
    approval: approval ?? null,
  });
}

/**
 * Synchronous observation of existing state, never authorization or global enforcement.
 * Historical audits are read-only. Latest/reuse may create/repair required trace artifacts;
 * existing approval usability may emit a refusal audit. No business effect, claim or release.
 * The checked DOT gate may authorize only internal admission. Concrete pipeline-step authority
 * remains the real executor/default adapter's responsibility and is not qualified here.
 */
export function validateDotJudgmentPreEffect(
  input: DotJudgmentPreEffectInput,
  deps: DotJudgmentPreEffectDeps
): DotJudgmentPreEffectResult {
  try {
    const before = judgmentCanonicalHash(input),
      selected = selectorSchema.parse(input);
    if (before !== judgmentCanonicalHash(selected)) throw new Error('Lossy selectors');
    let lastTime = -Infinity;
    const now = () => {
      const value = synchronous(deps.now());
      if (!Number.isFinite(value) || value < lastTime) throw new Error('Invalid current clock');
      lastTime = value;
      return value;
    };
    const state = immutable(synchronous(deps.readExecutionState()));
    const binding = validateState(selected, state, now());
    const effect = mappedEffect(state, deps),
      request = effect.request;
    const current = immutable(synchronous(deps.readCurrentContext()));
    if (checkJudgmentContext({ ...request.context, ...current }).status !== 'valid')
      throw new Error('Current evidence differs');
    const origin = readHistoricalJudgmentEvidence({
      scope: binding.scope,
      binding: binding.judgment_binding,
      effectRef: binding.effect_ref,
      address: binding.origin_receipt,
    });
    if (
      origin.status !== 'historical_verified' ||
      origin.assessment.verdict.disposition !== 'apply_precedent' ||
      modelHash(origin.model_input) !== modelHash(request.context.modelInput)
    )
      throw new Error('Original audit differs');
    const evidenceDeps: JudgmentEvidenceDeps = {
      now,
      readCurrentContext: () => synchronous(deps.readCurrentContext()),
    };
    const latest = resolveLatestJudgmentEvidence(
      {
        ...request,
        parent: { evaluation_key: binding.evaluation_parent_key, effect_key: binding.effect_key },
      },
      evidenceDeps
    );
    if (
      latest.status !== 'persisted' ||
      latest.assessment.verdict.disposition !== 'apply_precedent'
    )
      throw new Error('Latest verdict refuses');
    const audited = readHistoricalJudgmentEvidence({
      scope: binding.scope,
      binding: binding.judgment_binding,
      effectRef: binding.effect_ref,
      address: latest.reference.address,
    });
    if (
      audited.status !== 'historical_verified' ||
      modelHash(audited.model_input) !== modelHash(request.context.modelInput)
    )
      throw new Error('Latest facts differ');
    const firstAuthority = authority(state, deps, now);
    const pinned = reuseJudgmentEvidence(
      { ...request, address: latest.reference.address },
      evidenceDeps
    );
    if (
      pinned.status !== 'persisted' ||
      pinned.assessment.verdict.disposition !== 'apply_precedent'
    )
      throw new Error('Latest changed');
    const finalEffect = mappedEffect(state, deps);
    const finalAuthority = authority(state, deps, now);
    const finalContext = immutable(synchronous(deps.readCurrentContext()));
    if (checkJudgmentContext({ ...request.context, ...finalContext }).status !== 'valid')
      throw new Error('Final evidence differs');
    const finalState = immutable(synchronous(deps.readExecutionState()));
    validateState(selected, finalState, now());
    if (
      judgmentCanonicalHash(state) !== judgmentCanonicalHash(finalState) ||
      judgmentCanonicalHash(effect) !== judgmentCanonicalHash(finalEffect) ||
      judgmentCanonicalHash(current) !== judgmentCanonicalHash(finalContext) ||
      judgmentCanonicalHash(firstAuthority) !== judgmentCanonicalHash(finalAuthority)
    )
      throw new Error('Eligibility changed');
    const observed = now();
    validateState(selected, finalState, observed);
    const evaluated = Date.parse(pinned.assessment.evaluated_at),
      expires = Date.parse(pinned.assessment.expires_at);
    if (
      !Number.isFinite(evaluated) ||
      !Number.isFinite(expires) ||
      evaluated > observed ||
      observed >= expires ||
      observed - evaluated > 5 * 60_000 ||
      (finalAuthority.approval && isApprovalRequestExpired(finalAuthority.approval, observed))
    )
      throw new Error('Receipt or captured approval expired at the final observation');
    return immutable({
      status: 'eligible_observed' as const,
      observed_at: new Date(observed).toISOString(),
      actor_id: dotActorId(state.charter.dot_id),
      authority_role: state.charter.authority.authority_role,
      origin_receipt: binding.origin_receipt,
      latest_receipt: pinned.reference,
      proposal_facts: effect.proposalFacts,
      goals: [...effect.goals],
      observation_hash: judgmentCanonicalHash({
        state: finalState,
        effect: finalEffect,
        authority: finalAuthority,
        current: finalContext,
        latest: pinned.reference,
      }),
    });
  } catch {
    return { status: 'unavailable', reason: 'pre_effect_unavailable' };
  }
}
