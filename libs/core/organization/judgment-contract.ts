/** Pure, bounded contracts. A semantic judgment never grants execution authority. */
import { z } from 'zod';
import { assertScopeContext, type ScopeContext } from '../foundation/scope-context-validation.js';

export const JUDGMENT_MODEL_INPUT_MAX_BYTES = 32 * 1024;
export const JUDGMENT_MODEL_OUTPUT_MAX_BYTES = 16 * 1024;

const key = z.string().trim().min(1).max(128);
const explanation = z.string().trim().min(1).max(2000);
const itemText = z.string().trim().min(1).max(500);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const users = z.number().finite().int().min(1).max(10_000);
const p95 = z.number().finite().min(1).max(60_000);
const cost = z.number().finite().int().min(0).max(1_000_000);
const texts = z.array(itemText).max(10);
const uniqueKeys = z
  .array(key)
  .min(1)
  .max(10)
  .refine((values) => new Set(values).size === values.length, 'Reference keys must be unique');

function withinBytes(value: unknown, limit: number): boolean {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= limit;
}

/** This is the only model-returned contract: no scope, bindings, roles or approvals. */
export const semanticVerdictSchema = z
  .discriminatedUnion('disposition', [
    z
      .object({
        disposition: z.literal('apply_precedent'),
        precedent_keys: uniqueKeys,
        rationale: explanation,
        applicability: texts.min(1),
      })
      .strict(),
    z
      .object({
        disposition: z.literal('reframe'),
        violated_goal_keys: uniqueKeys,
        rationale: explanation,
        revised_question: explanation,
        evidence_needed: texts,
      })
      .strict(),
    z
      .object({
        disposition: z.literal('escalate'),
        rationale: explanation,
        question: explanation,
        options: z
          .array(z.object({ label: itemText, consequences: itemText }).strict())
          .min(2)
          .max(4),
        missing_facts: texts,
      })
      .strict(),
  ])
  .refine(
    (value) => withinBytes(value, JUDGMENT_MODEL_OUTPUT_MAX_BYTES),
    'Model output exceeds UTF-8 byte limit'
  );

export type SemanticVerdict = z.infer<typeof semanticVerdictSchema>;
export type SemanticDisposition = SemanticVerdict['disposition'];

/** Set exclusively by the trusted caller; never merge this from model output. */
export const judgmentBindingSchema = z
  .object({
    schema_version: z.literal('1'),
    work_ref: key,
    work_revision: key,
    trigger_key: key,
    scope_hash: hash,
    request_hash: hash,
    evidence_hash: hash,
    precedent_snapshot_hash: hash,
    policy_version: key,
    rubric_version: key,
    evaluator_version: key,
    model_config_hash: hash,
  })
  .strict();
export type JudgmentBinding = z.infer<typeof judgmentBindingSchema>;

export const decisionEvidenceRefSchema = z
  .object({
    source_key: key,
    case_id: key,
    decision_id: key,
    decision_version_hash: hash,
    basis: z
      .array(z.object({ ref: itemText, version: itemText }).strict())
      .min(1)
      .max(10),
  })
  .strict();
export type DecisionEvidenceRef = z.infer<typeof decisionEvidenceRefSchema>;

export const latencyGoalConstraintsSchema = z
  .object({
    kind: z.literal('latency_goal_v1'),
    goal_key: key,
    decision_source_key: key,
    service_key: key,
    load_profile_hash: hash,
    target_users: users,
    max_p95_ms: p95,
    max_incremental_monthly_cost: cost,
    currency: z.literal('JPY'),
    permitted_change: z.literal('isolated_fixture_only'),
  })
  .strict();
export type LatencyGoalConstraints = z.infer<typeof latencyGoalConstraintsSchema>;

export const latencyProposalFactsSchema = z
  .object({
    proposal_key: key,
    service_key: key,
    load_profile_hash: hash,
    change_scope: z.literal('isolated_fixture_only'),
    requested_goal: z.object({ target_users: users, max_p95_ms: p95 }).strict(),
    incremental_monthly_cost: cost,
    currency: z.literal('JPY'),
  })
  .strict();
export type LatencyProposalFacts = z.infer<typeof latencyProposalFactsSchema>;

/** Reuses the canonical scope validator, without accepting compatibility aliases. */
export const judgmentScopeSchema = z
  .object({
    tier: z.enum(['personal', 'confidential', 'public']),
    tenant_slug: key.optional(),
    organization_id: key.optional(),
    project_id: key.optional(),
    mission_id: key.optional(),
    task_id: key.optional(),
    session_id: key.optional(),
    work_shape: key.optional(),
    customer_stance: key.optional(),
    viewer_principal: key.optional(),
    nhi_id: key.optional(),
  })
  .strict()
  .transform((input, ctx): ScopeContext => {
    try {
      return assertScopeContext(input);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid canonical judgment scope' });
      return z.NEVER;
    }
  });

/** Bounded model-visible data; authenticity and scope remain caller responsibilities. */
export const judgmentModelInputSchema = z
  .object({
    goals: z.array(latencyGoalConstraintsSchema).min(1).max(10),
    precedents: z.array(z.object({ source_key: key, summary: explanation }).strict()).max(10),
    proposal: latencyProposalFactsSchema,
    evidence: z.array(z.object({ evidence_key: key, text: explanation }).strict()).max(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    const groups = [
      { path: 'goals', keys: value.goals.map((goal) => goal.goal_key) },
      { path: 'precedents', keys: value.precedents.map((precedent) => precedent.source_key) },
      { path: 'evidence', keys: value.evidence.map((evidence) => evidence.evidence_key) },
    ];
    for (const group of groups) {
      if (new Set(group.keys).size !== group.keys.length)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [group.path],
          message: 'Reference keys must be unique',
        });
    }
  })
  .refine(
    (value) => withinBytes(value, JUDGMENT_MODEL_INPUT_MAX_BYTES),
    'Model input exceeds UTF-8 byte limit'
  );
export type JudgmentModelInput = z.infer<typeof judgmentModelInputSchema>;

export const judgmentUnavailableReasonSchema = z.enum([
  'invalid_schema',
  'missing_evidence',
  'scope_mismatch',
  'stale_precedent',
  'conflicting_precedents',
  'budget_exhausted',
  'provider_error',
  'deadline_exceeded',
  'cancelled',
]);
export type JudgmentUnavailableReason = z.infer<typeof judgmentUnavailableReasonSchema>;

const evaluatedSchema = z
  .object({
    status: z.literal('evaluated'),
    binding: judgmentBindingSchema,
    verdict: semanticVerdictSchema,
    evidence_refs: z.array(decisionEvidenceRefSchema).max(10),
    provider: key,
    model: key,
    evaluated_at: z.string().datetime(),
    expires_at: z.string().datetime(),
    audit_summary: explanation,
  })
  .strict();

/** Structural only: callers must verify source authenticity and applicability separately. */
export const judgmentAssessmentSchema = z
  .discriminatedUnion('status', [
    evaluatedSchema,
    z
      .object({
        status: z.literal('unavailable'),
        reason: judgmentUnavailableReasonSchema,
        detail: explanation,
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.status !== 'evaluated') return;
    const evaluated = Date.parse(value.evaluated_at);
    const expires = Date.parse(value.expires_at);
    if (
      !Number.isFinite(evaluated) ||
      !Number.isFinite(expires) ||
      expires <= evaluated ||
      expires - evaluated > 5 * 60_000
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Receipt lifetime must be positive and at most five minutes',
      });
    }
  });
export type JudgmentAssessment = z.infer<typeof judgmentAssessmentSchema>;

export function parseJudgmentModelInput(input: unknown): JudgmentModelInput {
  return judgmentModelInputSchema.parse(input);
}

export function parseSemanticVerdict(input: unknown): SemanticVerdict {
  return semanticVerdictSchema.parse(input);
}
