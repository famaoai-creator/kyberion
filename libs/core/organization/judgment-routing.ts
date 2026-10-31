/** Synthetic routing only: persisted semantic evidence never replaces the existing effect gate. */
import { z } from 'zod';
import { detectRouteCycle, selectJudgeRoute } from '../judge-route.js';
import type { AutonomousOpsGateResult } from '../governance/autonomous-ops-gate.js';
import {
  latencyProposalFactsSchema,
  parseJudgmentModelInput,
  type JudgmentAssessment,
  type LatencyProposalFacts,
  type LatencyGoalConstraints,
} from './judgment-contract.js';
import {
  reuseJudgmentEvidence,
  type JudgmentEvidenceDeps,
  type JudgmentEvidenceReference,
  type JudgmentEvidenceRequest,
  type JudgmentReceiptAddress,
} from './judgment-evidence.js';
import { judgmentCanonicalHash } from './judgment-precedents.js';

export type JudgmentSyntheticRoute = 'apply_plan' | 'reframe' | 'question_draft';
export interface JudgmentRoutingHistoryEntry {
  work_ref: string;
  route: JudgmentSyntheticRoute;
}
export interface SyntheticJudgmentRoutingRequest {
  mode: 'offline_fixture';
  evidence: JudgmentEvidenceRequest & { address: JudgmentReceiptAddress };
  /** Independently trusted candidate facts, not copied from a model verdict. */
  originalProposal: LatencyProposalFacts;
  /** Effective policy action selected by the trusted original DotProposal/charter adapter. */
  gateActionId: string;
  history: readonly JudgmentRoutingHistoryEntry[];
}
interface RouteContext {
  work_ref: string;
  work_revision: string;
  effect_ref: string;
  receipt: JudgmentEvidenceReference;
  proposal: LatencyProposalFacts;
}
export interface SyntheticJudgmentApplyPlan extends RouteContext {
  kind: 'synthetic_apply_plan';
  gate: { action_id: string; policy_version: string; decision: 'auto' | 'notify' };
}
export interface SyntheticJudgmentReplan extends RouteContext {
  kind: 'synthetic_replan';
  original_goal_keys: string[];
  original_goals: LatencyGoalConstraints[];
  violated_goal_keys: string[];
  revised_question: string;
  evidence_needed: string[];
}
export interface SyntheticJudgmentQuestionDraft extends RouteContext {
  kind: 'synthetic_question_draft';
  question_kind: 'value_decision';
  question: string;
  options: Array<{ label: string; consequences: string }>;
  missing_facts: string[];
}
export interface SyntheticJudgmentRoutingDeps {
  evidence: JudgmentEvidenceDeps;
  /**
   * Trusted adapter closed over the original normalized DotProposal, charter, bounds and
   * evaluateDotProposalGate. This port supplies its existing result; it is not a new gate.
   */
  gate(input: RouteContext & { gate_action_id: string }): AutonomousOpsGateResult;
  /** Synchronous offline plan/draft recorders only. No execution, sends or approval mutation. */
  onApplyPlan(plan: SyntheticJudgmentApplyPlan): undefined;
  onReplan(replan: SyntheticJudgmentReplan): undefined;
  onQuestionDraft(draft: SyntheticJudgmentQuestionDraft): undefined;
}
type Unavailable = Extract<JudgmentAssessment, { status: 'unavailable' }>;
export type SyntheticJudgmentRoutingResult =
  | { status: 'planned'; plan: SyntheticJudgmentApplyPlan; history: JudgmentRoutingHistoryEntry[] }
  | { status: 'reframed'; replan: SyntheticJudgmentReplan; history: JudgmentRoutingHistoryEntry[] }
  | {
      status: 'question_drafted';
      draft: SyntheticJudgmentQuestionDraft;
      history: JudgmentRoutingHistoryEntry[];
    }
  | {
      status: 'blocked';
      reason: 'gate_denied' | 'route_cycle' | 'route_limit' | 'callback_error';
      detail: string;
    }
  | Unavailable;

const key = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim());
const historySchema = z
  .array(
    z.object({ work_ref: key, route: z.enum(['apply_plan', 'reframe', 'question_draft']) }).strict()
  )
  .max(6);
const routes = [
  { when: { label: 'apply_precedent' }, next: 'apply_plan' },
  { when: { label: 'reframe' }, next: 'reframe' },
  { when: { label: 'escalate' }, next: 'question_draft' },
];
const gateSchema = z
  .object({
    actionId: key,
    decision: z.enum(['auto', 'notify', 'approve']),
    allowed: z.boolean(),
    shadow: z.boolean(),
    executionMode: z.enum(['apply', 'dry_run']),
    policyVersion: key,
    tenantSlug: key.optional(),
    score: z.number().finite().min(0),
    maxScore: z.number().finite().min(0),
  })
  .passthrough();

const unavailable = (detail: string): Unavailable => ({
  status: 'unavailable',
  reason: 'invalid_schema',
  detail,
});
const blocked = (
  reason: Extract<SyntheticJudgmentRoutingResult, { status: 'blocked' }>['reason'],
  detail: string
): SyntheticJudgmentRoutingResult => ({ status: 'blocked', reason, detail });
function strictFields(value: object, fields: string[]): void {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new Error('Unsupported routing field');
}

/** Caller-owned history bounds this fixture loop; no parallel workflow or authority store exists. */
export function routeSyntheticJudgment(
  input: SyntheticJudgmentRoutingRequest,
  deps: SyntheticJudgmentRoutingDeps
): SyntheticJudgmentRoutingResult {
  let request: SyntheticJudgmentRoutingRequest;
  let history: JudgmentRoutingHistoryEntry[];
  let proposal: LatencyProposalFacts;
  let inputHash: string;
  try {
    inputHash = judgmentCanonicalHash(input);
    strictFields(input, ['mode', 'evidence', 'originalProposal', 'gateActionId', 'history']);
    strictFields(input.evidence, ['context', 'effectRef', 'modelConfig', 'address']);
    strictFields(input.evidence.context, [
      'binding',
      'scope',
      'modelInput',
      'snapshot',
      'requiredGoalKeys',
      'knownProposalKeys',
    ]);
    if (input.mode !== 'offline_fixture')
      return unavailable('Only offline synthetic routing is supported');
    request = structuredClone(input);
    key.parse(request.gateActionId);
    history = historySchema.parse(request.history);
    proposal = latencyProposalFactsSchema.parse(request.originalProposal);
    if (judgmentCanonicalHash(proposal) !== judgmentCanonicalHash(request.originalProposal))
      return unavailable('Original proposal must already be canonical');
    const storedProposal = parseJudgmentModelInput(request.evidence.context.modelInput).proposal;
    if (judgmentCanonicalHash(proposal) !== judgmentCanonicalHash(storedProposal))
      return unavailable('Original proposal differs from the receipt-bound candidate');
  } catch {
    return unavailable('Synthetic routing failed its strict bounded request contract');
  }
  const unchangedInput = (): boolean => {
    try {
      return judgmentCanonicalHash(input) === inputHash;
    } catch {
      return false;
    }
  };

  const first = reuseJudgmentEvidence(request.evidence, deps.evidence);
  if (first.status === 'unavailable') return first;
  if (!unchangedInput())
    return unavailable('Caller-owned routing context changed during receipt validation');
  const binding = first.assessment.binding;
  if (history.some((entry) => entry.work_ref !== binding.work_ref))
    return unavailable('Routing history belongs to another work item');
  const selection = selectJudgeRoute(
    { label: first.assessment.verdict.disposition },
    routes
  ).selection;
  if (!selection.matched || !['apply_plan', 'reframe', 'question_draft'].includes(selection.next))
    return unavailable('No fixed synthetic route matches the assessment');
  const route = selection.next as JudgmentSyntheticRoute;
  if (route === 'reframe' && history.filter((entry) => entry.route === 'reframe').length >= 2)
    return blocked('route_limit', 'The synthetic work exhausted its two reframe rounds');
  const nextHistory = [...history, { work_ref: binding.work_ref, route }];
  if (
    detectRouteCycle(
      nextHistory.map((entry) => entry.route),
      6
    ).detected
  )
    return blocked(
      'route_cycle',
      'A repeated route or bounded hop limit stopped synthetic planning'
    );

  const context = (reference: JudgmentEvidenceReference): RouteContext => ({
    work_ref: binding.work_ref,
    work_revision: binding.work_revision,
    effect_ref: request.evidence.effectRef,
    receipt: reference,
    proposal: structuredClone(proposal),
  });
  try {
    if (route === 'apply_plan') {
      const gateInput = { ...context(first.reference), gate_action_id: request.gateActionId };
      const gateInputHash = judgmentCanonicalHash(gateInput);
      const result = deps.gate(gateInput);
      if (judgmentCanonicalHash(gateInput) !== gateInputHash || !unchangedInput())
        return unavailable('Gate adapter changed candidate facts or caller-owned routing context');
      // The existing gate legitimately carries optional undefined metadata. Validate the
      // fields this adapter relies on without treating that metadata as model JSON.
      if (!result || Object.getPrototypeOf(result) !== Object.prototype)
        return blocked('gate_denied', 'The existing gate result is malformed');
      if (
        [
          'actionId',
          'decision',
          'allowed',
          'shadow',
          'executionMode',
          'policyVersion',
          'tenantSlug',
          'score',
          'maxScore',
        ].some((field) => {
          const property = Object.getOwnPropertyDescriptor(result, field);
          return property !== undefined && !('value' in property);
        })
      )
        return blocked(
          'gate_denied',
          'The existing gate result has unsupported property accessors'
        );
      const parsed = gateSchema.safeParse(result);
      if (!parsed.success) return blocked('gate_denied', 'The existing gate result is malformed');
      const gate = parsed.data;
      if (
        gate.allowed !== true ||
        gate.shadow !== false ||
        gate.executionMode !== 'apply' ||
        (gate.decision !== 'auto' && gate.decision !== 'notify') ||
        gate.actionId !== request.gateActionId ||
        gate.policyVersion !== binding.policy_version ||
        gate.tenantSlug !== request.evidence.context.scope.tenant_slug
      ) {
        return blocked(
          'gate_denied',
          'The existing gate did not permit planning for this action, policy and tenant'
        );
      }
      const latest = reuseJudgmentEvidence(request.evidence, deps.evidence);
      if (latest.status === 'unavailable') return latest;
      const refreshedProposal = parseJudgmentModelInput(
        request.evidence.context.modelInput
      ).proposal;
      if (
        judgmentCanonicalHash(proposal) !== judgmentCanonicalHash(refreshedProposal) ||
        !unchangedInput()
      )
        return unavailable('Original candidate facts changed before the planning callback');
      const plan: SyntheticJudgmentApplyPlan = {
        ...context(latest.reference),
        kind: 'synthetic_apply_plan',
        gate: {
          action_id: gate.actionId,
          policy_version: gate.policyVersion,
          decision: gate.decision,
        },
      };
      if (deps.onApplyPlan(structuredClone(plan)) !== undefined)
        return blocked(
          'callback_error',
          'The offline planning recorder violated its synchronous contract'
        );
      return { status: 'planned', plan, history: nextHistory };
    }
    const latest = reuseJudgmentEvidence(request.evidence, deps.evidence);
    if (latest.status === 'unavailable') return latest;
    if (!unchangedInput())
      return unavailable('Caller-owned routing context changed before draft planning');
    const verdict = latest.assessment.verdict;
    if (route === 'reframe' && verdict.disposition === 'reframe') {
      const replan: SyntheticJudgmentReplan = {
        ...context(latest.reference),
        kind: 'synthetic_replan',
        original_goal_keys: [...request.evidence.context.requiredGoalKeys],
        original_goals: structuredClone(request.evidence.context.snapshot.goals),
        violated_goal_keys: [...verdict.violated_goal_keys],
        revised_question: verdict.revised_question,
        evidence_needed: [...verdict.evidence_needed],
      };
      if (deps.onReplan(structuredClone(replan)) !== undefined)
        return blocked(
          'callback_error',
          'The offline replan recorder violated its synchronous contract'
        );
      return { status: 'reframed', replan, history: nextHistory };
    }
    if (route === 'question_draft' && verdict.disposition === 'escalate') {
      const draft: SyntheticJudgmentQuestionDraft = {
        ...context(latest.reference),
        kind: 'synthetic_question_draft',
        question_kind: 'value_decision',
        question: verdict.question,
        options: structuredClone(verdict.options),
        missing_facts: [...verdict.missing_facts],
      };
      if (deps.onQuestionDraft(structuredClone(draft)) !== undefined)
        return blocked(
          'callback_error',
          'The offline draft recorder violated its synchronous contract'
        );
      return { status: 'question_drafted', draft, history: nextHistory };
    }
    return unavailable('Persisted assessment does not match the fixed route');
  } catch {
    return blocked(
      'callback_error',
      'A synthetic gate or plan/draft recorder failed; no automatic retry is attempted'
    );
  }
}
