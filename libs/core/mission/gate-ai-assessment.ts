/**
 * Gate AI assessment — the artifact contract and policy evaluation for
 * "AI evaluates and scores, humans decide" phase-gating.
 *
 * Modelled on the video-production evidence chain (`video-eval-report`):
 * the AI produces a structured verdict + per-criterion scores bound to the
 * evidence it read (sha256), a machine check blocks convening the review
 * body on low-confidence / unmet-required inputs, and the human decision
 * record carries the assessment digest so a stale evaluation can never be
 * approved twice (hash-bound approval).
 */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { createLogger } from '../logger.js';
import { readJsonIfPresent } from '../foundation/json.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFileRange,
  safeStat,
} from '../secure-io.js';

const logger = createLogger('gate-ai-assessment');

export const GATE_AI_ASSESSMENT_FILE = 'evidence/gate-ai-assessment.json';
export const GATE_DECISION_RECORD_FILE = 'evidence/gate-decision-record.json';

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

export interface GateAiAssessmentPolicy {
  /** Minimum acceptable confidence (0..1). Default 0.5. */
  min_confidence?: number;
  /** Maximum criteria allowed in `unmet`/`unknown` state. Default 0. */
  max_unmet?: number;
  /** Fail when any required artifact is missing/insufficient. Default true. */
  block_missing_required?: boolean;
  /** Fail when declared evaluated_evidence digests no longer match. Default true. */
  require_fresh_evidence?: boolean;
}

export interface GateAiAssessmentCheckResult {
  passed: boolean;
  reasons: string[];
}

function unmetCriteria(assessment: GateAiAssessment) {
  return assessment.criteria.filter(
    (criterion) => criterion.status === 'unmet' || criterion.status === 'unknown'
  );
}

function absentArtifacts(assessment: GateAiAssessment) {
  return (assessment.required_artifacts ?? []).filter(
    (artifact) => artifact.status === 'missing' || artifact.status === 'insufficient'
  );
}

/** Consistency between the recommended verdict and the criterion/artifact states. */
function consistencyReasons(assessment: GateAiAssessment): string[] {
  const unmet = unmetCriteria(assessment).length;
  const absent = absentArtifacts(assessment).length;
  const reasons: string[] = [];
  if (assessment.recommended_verdict === 'go' && (unmet > 0 || absent > 0)) {
    reasons.push(
      `verdict "go" is inconsistent with ${unmet} unmet/unknown criteria and ${absent} absent required artifacts`
    );
  }
  if (assessment.recommended_verdict === 'no_go' && unmet === 0 && absent === 0) {
    reasons.push(
      'verdict "no_go" is inconsistent: every criterion is met and every required artifact is present'
    );
  }
  if (
    assessment.recommended_verdict === 'conditional_go' &&
    (assessment.conditions ?? []).length === 0
  ) {
    reasons.push('verdict "conditional_go" requires at least one condition');
  }
  return reasons;
}

/**
 * Evaluate whether the assessment clears the convening policy — the "entry
 * criteria" for holding the human review body. A failing result means the
 * packet is not ready for judgment: fix the evidence or the assessment, or
 * record a human override.
 */
export function evaluateGateAiAssessmentPolicy(
  assessment: GateAiAssessment,
  policy: GateAiAssessmentPolicy = {}
): GateAiAssessmentCheckResult {
  const minConfidence = policy.min_confidence ?? 0.5;
  const maxUnmet = policy.max_unmet ?? 0;
  const blockMissingRequired = policy.block_missing_required ?? true;
  const reasons: string[] = [];

  if (assessment.confidence < minConfidence) {
    reasons.push(
      `confidence ${assessment.confidence} is below the required minimum ${minConfidence}`
    );
  }
  const unmet = unmetCriteria(assessment);
  if (unmet.length > maxUnmet) {
    reasons.push(
      `${unmet.length} criteria are unmet/unknown (allowed: ${maxUnmet}): ${unmet
        .map((criterion) => `${criterion.criterion} [${criterion.status}]`)
        .join('; ')}`
    );
  }
  if (blockMissingRequired) {
    const absent = absentArtifacts(assessment);
    if (absent.length > 0) {
      reasons.push(
        `${absent.length} required artifacts are absent: ${absent
          .map((artifact) => `${artifact.artifact} [${artifact.status}]`)
          .join('; ')}`
      );
    }
  }
  // An AI no_go blocks convening independently of the criterion thresholds:
  // the assessor judged the gate not ready, so a human must either improve
  // the evidence or record an explicit override.
  if (assessment.recommended_verdict === 'no_go') {
    reasons.push('recommended verdict is no_go — remediate or record a human override');
  }
  reasons.push(...consistencyReasons(assessment));
  return { passed: reasons.length === 0, reasons };
}

const DIGEST_CHUNK_SIZE = 1024 * 1024;

/**
 * Chunked digest (1MB windows) with a size/mtime re-check so a file changed
 * mid-read cannot produce a plausible-looking hash — same discipline as
 * videoArtifactDigest.
 */
export function sha256FileDigest(filePath: string): string {
  const before = safeStat(filePath);
  const hash = createHash('sha256');
  for (let offset = 0; offset < before.size; offset += DIGEST_CHUNK_SIZE) {
    hash.update(
      safeReadFileRange(filePath, offset, Math.min(DIGEST_CHUNK_SIZE, before.size - offset))
    );
  }
  const after = safeStat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`file changed during digest: ${filePath}`);
  }
  return hash.digest('hex');
}

function resolveAssessmentEvidencePath(entryPath: string, missionDir: string): string | undefined {
  const candidates = entryPath.startsWith('evidence/')
    ? [path.join(missionDir, entryPath)]
    : [path.join(missionDir, 'evidence', entryPath), entryPath];
  for (const candidate of candidates) {
    try {
      const resolved = assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
      if (safeExistsSync(resolved) && safeLstat(resolved).isFile()) return resolved;
    } catch {
      // Denied paths fall through: the caller reports the stale/unverifiable entry.
    }
  }
  return undefined;
}

/**
 * Freshness check — every declared evaluated_evidence entry must still hash to
 * the recorded digest. A changed input invalidates the assessment (hash-bound
 * evaluation), exactly like a video evaluation bound to an old scene plan.
 */
export function verifyGateAiAssessmentFreshness(
  assessment: GateAiAssessment,
  missionDir: string
): GateAiAssessmentCheckResult {
  const reasons: string[] = [];
  for (const entry of assessment.evaluated_evidence ?? []) {
    const resolved = resolveAssessmentEvidencePath(entry.path, missionDir);
    if (!resolved) {
      reasons.push(`evaluated evidence is unavailable: ${entry.path}`);
      continue;
    }
    const digest = sha256FileDigest(resolved);
    if (digest !== entry.sha256) {
      reasons.push(
        `evaluated evidence changed since assessment: ${entry.path} (recorded ${entry.sha256.slice(0, 12)}…, current ${digest.slice(0, 12)}…)`
      );
    }
  }
  return { passed: reasons.length === 0, reasons };
}

/**
 * Bind the human decision record to the assessment the body reviewed. The
 * recorded sha256 must equal the digest of the current assessment file.
 */
export function verifyGateDecisionBinding(input: {
  record: GateDecisionRecord;
  assessmentFileDigest: string;
  assessmentRef?: string;
}): GateAiAssessmentCheckResult {
  const reasons: string[] = [];
  if (input.record.ai_assessment_sha256 !== input.assessmentFileDigest) {
    reasons.push(
      `decision is bound to a different assessment (recorded ${input.record.ai_assessment_sha256.slice(0, 12)}…, current ${input.assessmentFileDigest.slice(0, 12)}…) — re-assess or re-decide`
    );
  }
  if (input.assessmentRef && input.record.ai_assessment_ref !== input.assessmentRef) {
    reasons.push(
      `ai_assessment_ref "${input.record.ai_assessment_ref}" does not match expected "${input.assessmentRef}"`
    );
  }
  if (input.record.decision === 'conditional_go' && (input.record.conditions ?? []).length === 0) {
    reasons.push('conditional_go decision requires at least one condition');
  }
  return { passed: reasons.length === 0, reasons };
}

function firstReadablePath(paths: string[]): string | undefined {
  for (const candidate of paths) {
    try {
      const resolved = assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
      if (safeExistsSync(resolved) && safeLstat(resolved).isFile()) return resolved;
    } catch {
      // Try the next candidate location.
    }
  }
  return undefined;
}

/** Load and schema-validate an assessment file from a mission evidence dir. */
export function loadGateAiAssessment(
  missionDir: string,
  relativePath: string = GATE_AI_ASSESSMENT_FILE
): { assessment?: GateAiAssessment; path?: string; error?: string } {
  const candidates = path.isAbsolute(relativePath)
    ? [relativePath]
    : [path.join(missionDir, relativePath), path.join(missionDir, 'evidence', relativePath)];
  const file = firstReadablePath(candidates);
  if (!file) return { error: `assessment file not found: ${relativePath}` };
  const raw = readJsonIfPresent<unknown>(file);
  if (raw === null) return { error: `assessment file is unreadable: ${file}` };
  const parsed = GateAiAssessmentSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('/') || '/'} ${issue.message}`)
      .join('; ');
    return { error: `assessment failed schema validation: ${issues}` };
  }
  return { assessment: parsed.data, path: file };
}

/** Load and schema-validate the human decision record. */
export function loadGateDecisionRecord(
  missionDir: string,
  relativePath: string = GATE_DECISION_RECORD_FILE
): { record?: GateDecisionRecord; path?: string; error?: string } {
  const candidates = path.isAbsolute(relativePath)
    ? [relativePath]
    : [path.join(missionDir, relativePath), path.join(missionDir, 'evidence', relativePath)];
  const file = firstReadablePath(candidates);
  if (!file) return { error: `decision record not found: ${relativePath}` };
  const raw = readJsonIfPresent<unknown>(file);
  if (raw === null) return { error: `decision record is unreadable: ${file}` };
  const parsed = GateDecisionRecordSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('/') || '/'} ${issue.message}`)
      .join('; ');
    return { error: `decision record failed schema validation: ${issues}` };
  }
  return { record: parsed.data, path: file };
}

export function logAssessmentCheckResult(
  stage: string,
  verdict: GateAiAssessmentCheckResult
): void {
  if (verdict.passed) return;
  for (const reason of verdict.reasons) {
    logger.warn(`[gate-ai-assessment:${stage}] ${reason}`);
  }
}
