import { assertMemoryScope, type MemoryScopeEnvelope } from './memory-scope.js';
import {
  createDistillCandidateRecord,
  saveDistillCandidateRecord,
  type DistillCandidateRecord,
} from './distill-candidate-registry.js';
import { validatePipelineAdf } from './pipeline-contract.js';
import { validatePipelineGuardrails } from './adf-guardrails.js';
import {
  compileServiceRecording,
  type CompileServiceResult,
} from './service-recording-compiler.js';
import { validateServiceRecording, type ServiceRecording } from './service-recording.js';

export interface BuildServiceProcedureCandidateOptions {
  procedureId?: string;
  intentPhrases: string[];
  targetName?: string;
  recordingRef?: string;
  title?: string;
  summary?: string;
  tier?: 'personal' | 'confidential' | 'public';
  tenantSlug?: string;
  projectId?: string;
  missionId?: string;
  taskSessionId?: string;
  ownerNhi?: string;
  locale?: string;
}

export interface ServiceProcedureCandidateResult {
  procedure_id: string;
  pipeline: CompileServiceResult['pipeline'];
  preflight: { ok: boolean; findings: string[] };
  candidate: DistillCandidateRecord;
}

export interface ServiceDistillCandidateAssessmentInput {
  recording: unknown;
  intentPhrases: string[];
}

export interface ServiceDistillCandidateAssessment {
  eligible: boolean;
  reason: string;
  targetKind: 'procedure';
  reviewRequired: boolean;
}

function validateRecording(recording: ServiceRecording): ServiceRecording {
  const validation = validateServiceRecording(recording);
  if (!validation.value) {
    throw new Error(`recording failed validation: ${validation.errors.join('; ')}`);
  }
  return validation.value;
}

/** Apply service-specific eligibility rules before creating a distill record. */
export function assessServiceDistillCandidate(
  input: ServiceDistillCandidateAssessmentInput
): ServiceDistillCandidateAssessment {
  const validation = validateServiceRecording(input.recording);
  if (!validation.value) {
    return {
      eligible: false,
      reason: `Service recording is invalid: ${validation.errors.join('; ')}`,
      targetKind: 'procedure',
      reviewRequired: true,
    };
  }
  if (input.intentPhrases.length === 0 || input.intentPhrases.every((phrase) => !phrase.trim())) {
    return {
      eligible: false,
      reason: 'Service procedure candidate requires at least one intent phrase.',
      targetKind: 'procedure',
      reviewRequired: true,
    };
  }
  if (validation.value.steps.length === 0) {
    return {
      eligible: false,
      reason: 'Service recording has no operation steps to reuse.',
      targetKind: 'procedure',
      reviewRequired: true,
    };
  }
  const observationErrors = validation.value.steps.flatMap((step) => step.validation_errors || []);
  if (observationErrors.length > 0) {
    return {
      eligible: false,
      reason: `Service recording contains observation validation errors: ${observationErrors.join('; ')}`,
      targetKind: 'procedure',
      reviewRequired: true,
    };
  }
  return {
    eligible: true,
    reason: 'Service recording has validated preset operations and can enter human review.',
    targetKind: 'procedure',
    reviewRequired: true,
  };
}

function buildScope(
  options: BuildServiceProcedureCandidateOptions,
  recordingId: string
): MemoryScopeEnvelope | undefined {
  const tier = options.tier ?? 'personal';
  // Service recordings can contain business data and are never published as
  // public knowledge by this path. Publication needs its own brokered gate.
  if (tier === 'public') {
    throw new Error(
      'service procedure candidates cannot use public scope; publish through a brokered review flow'
    );
  }
  const scope: MemoryScopeEnvelope = {
    tier,
    ...(options.tenantSlug ? { tenant_slug: options.tenantSlug } : {}),
    ...(options.projectId ? { project_id: options.projectId } : {}),
    ...(options.missionId ? { mission_id: options.missionId } : {}),
    ...(options.taskSessionId ? { session_id: options.taskSessionId } : {}),
    ...(options.ownerNhi ? { owner_nhi: options.ownerNhi } : {}),
    promotion_policy: 'human_review',
    provenance_refs: [`recording:${recordingId}`],
  };
  // Validate only when an explicit scope was requested. Legacy personal
  // candidates may remain unscoped until the caller supplies an owner.
  if (
    options.tier ||
    options.tenantSlug ||
    options.projectId ||
    options.missionId ||
    options.taskSessionId ||
    options.ownerNhi
  ) {
    return assertMemoryScope(scope, tier);
  }
  return undefined;
}

/**
 * Turn a validated service recording into a review-only distill candidate.
 * This persists evidence and a draft ADF, but never writes a procedure catalog
 * and never makes the pipeline executable.
 */
export function buildServiceProcedureCandidate(
  recording: ServiceRecording,
  options: BuildServiceProcedureCandidateOptions
): ServiceProcedureCandidateResult {
  const assessment = assessServiceDistillCandidate({
    recording,
    intentPhrases: options.intentPhrases,
  });
  if (!assessment.eligible) throw new Error(`service candidate rejected: ${assessment.reason}`);
  const validated = validateRecording(recording);
  const compiled = compileServiceRecording(validated, {
    procedureId: options.procedureId,
    intentPhrases: options.intentPhrases,
    targetName: options.targetName,
    recordingRef: options.recordingRef,
    status: 'deprecated',
  });
  const validatedPipeline = validatePipelineAdf(compiled.pipeline);
  const guardrails = validatePipelineGuardrails(
    validatedPipeline,
    `service-candidate:${compiled.procedureEntry.procedure_id}`
  );
  const preflight = {
    ok: guardrails.ok,
    findings: guardrails.findings.map(
      (finding) => `${finding.severity}:${finding.code}:${finding.message}`
    ),
  };
  const sourceType = options.missionId ? 'mission' : 'task_session';
  const scope = buildScope(options, validated.recording_id);
  const candidate = createDistillCandidateRecord({
    source_type: sourceType,
    tier: options.tier ?? 'personal',
    ...(options.projectId ? { project_id: options.projectId } : {}),
    ...(options.missionId ? { mission_id: options.missionId } : {}),
    task_session_id: options.taskSessionId ?? validated.recording_id,
    title: options.title?.trim() || `Service procedure: ${validated.target.name}`,
    summary:
      options.summary?.trim() ||
      `Review candidate distilled from service recording ${validated.recording_id}; it remains non-executable until human approval.`,
    status: 'proposed',
    target_kind: 'procedure',
    ...(options.locale ? { locale: options.locale } : {}),
    evidence_refs: [
      `recording:${validated.recording_id}`,
      `pipeline:${compiled.procedureEntry.procedure_id}`,
    ],
    ...(scope ? { scope } : {}),
    metadata: {
      pipeline: validatedPipeline,
      procedure: compiled.procedureEntry,
      golden_scenario: compiled.goldenScenario,
      preflight,
      warnings: compiled.warnings,
      recording_ref: options.recordingRef,
      review_required: true,
      executable: false,
      promotion_state: 'review_required',
    },
  });
  saveDistillCandidateRecord(candidate);
  return {
    procedure_id: compiled.procedureEntry.procedure_id,
    pipeline: compiled.pipeline,
    preflight,
    candidate,
  };
}
