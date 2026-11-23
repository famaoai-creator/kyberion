/**
 * Gate AI assessment — the artifact contract for "AI evaluates and scores,
 * humans decide" phase-gating. Pure validation shapes only; evaluation
 * policy, evidence freshness and file loading live in
 * libs/core/mission/gate-ai-assessment.ts.
 */
import { z } from 'zod';

export const GATE_AI_ASSESSMENT_VERDICTS = ['go', 'conditional_go', 'no_go', 'hold'] as const;
export type GateAiAssessmentVerdict = (typeof GATE_AI_ASSESSMENT_VERDICTS)[number];

export const GATE_AI_ASSESSMENT_CRITERION_STATUSES = [
  'met',
  'partial',
  'unmet',
  'unknown',
] as const;
export type GateAiAssessmentCriterionStatus =
  (typeof GATE_AI_ASSESSMENT_CRITERION_STATUSES)[number];

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, 'expected a lowercase sha256 hex digest');

export const GateAiAssessmentCriterionSchema = z
  .object({
    criterion: z.string().min(1),
    status: z.enum(GATE_AI_ASSESSMENT_CRITERION_STATUSES),
    score: z.number().min(0).max(1).optional(),
    evidence_refs: z.array(z.string()).optional(),
    note: z.string().optional(),
  })
  .strict();

export const GateAiAssessmentArtifactStatusSchema = z
  .object({
    artifact: z.string().min(1),
    status: z.enum(['present', 'missing', 'insufficient']),
    ref: z.string().optional(),
  })
  .strict();

export const GateAiAssessmentEvidenceRefSchema = z
  .object({
    path: z.string().min(1),
    sha256: Sha256Schema,
  })
  .strict();

export const GateAiAssessmentConditionSchema = z
  .object({
    condition: z.string().min(1),
    owner: z.string().optional(),
    due: z.string().optional(),
  })
  .strict();

export const GateAiAssessmentSchema = z
  .object({
    kind: z.literal('gate-ai-assessment'),
    version: z.string().optional(),
    mission_id: z.string().min(1).optional(),
    gate_id: z.string().min(1),
    governance_body: z.string().min(1).optional(),
    assessed_at: z.string().min(1),
    assessor: z
      .object({
        backend: z.string().optional(),
        model_tier: z.string().optional(),
        agent: z.string().optional(),
      })
      .strict()
      .optional(),
    recommended_verdict: z.enum(GATE_AI_ASSESSMENT_VERDICTS),
    confidence: z.number().min(0).max(1),
    criteria: z.array(GateAiAssessmentCriterionSchema).min(1),
    required_artifacts: z.array(GateAiAssessmentArtifactStatusSchema).optional(),
    evaluated_evidence: z.array(GateAiAssessmentEvidenceRefSchema).optional(),
    risks: z.array(z.string()).optional(),
    missing_evidence: z.array(z.string()).optional(),
    conditions: z.array(GateAiAssessmentConditionSchema).optional(),
    notes: z.string().optional(),
  })
  .strict();

export type GateAiAssessment = z.infer<typeof GateAiAssessmentSchema>;

/**
 * The human decision record produced by the review body (会議体). It must
 * reference the exact assessment the deciders reviewed — ai_assessment_sha256
 * binds the decision to that evaluation, like the video playback approval
 * payload binding to the eval report digest.
 */
export const GateDecisionRecordSchema = z
  .object({
    decision: z.enum(GATE_AI_ASSESSMENT_VERDICTS),
    decider: z.string().min(1),
    decided_at: z.string().min(1),
    ai_assessment_ref: z.string().min(1),
    ai_assessment_sha256: Sha256Schema,
    conditions: z.array(GateAiAssessmentConditionSchema).optional(),
    rationale: z.string().optional(),
    quorum_met: z.boolean().optional(),
    attendees: z.array(z.string()).optional(),
  })
  .passthrough();

export type GateDecisionRecord = z.infer<typeof GateDecisionRecordSchema>;
