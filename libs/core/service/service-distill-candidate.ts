import type { StorageDataTier } from '../storage-layout.js';
import { assertMemoryScope, type MemoryScopeEnvelope } from '../knowledge/memory-scope.js';
import {
  captureFacadeProposal,
  type FacadeProposalRecord,
} from '../knowledge/facade-proposal-rows.js';
import { SERVICE_PROCEDURE_PROPOSAL } from '../knowledge/reuse-proposals.js';
import { validatePipelineAdf } from '../pipeline/pipeline-contract.js';
import { validatePipelineGuardrails } from '../pipeline/adf-guardrails.js';
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
  tier?: StorageDataTier;
  tenantSlug?: string;
  projectId?: string;
  missionId?: string;
  taskSessionId?: string;
  ownerNhi?: string;
  locale?: string;
}

/**
 * D8: a service procedure candidate is a MemoryCandidate queue row
 * (`origin.record_kind: service_procedure`, SERVICE_PROCEDURE_PROPOSAL)
 * captured with the recording's scope and decided on the Concierge
 * reuse-proposal panel.
 */
export interface ServiceProcedureCandidateResult {
  procedure_id: string;
  pipeline: CompileServiceResult['pipeline'];
  preflight: { ok: boolean; findings: string[] };
  candidate: FacadeProposalRecord;
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
): MemoryScopeEnvelope {
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
  // D8: scope is required at capture and never inferred — a personal
  // candidate names its owner, a confidential one its tenant.
  if (tier === 'personal' && !options.ownerNhi?.trim())
    throw new Error(
      '[MEMORY_SCOPE_REQUIRED] personal service procedure candidate needs --owner-nhi (or pass --tier confidential --tenant-slug <slug>)'
    );
  return assertMemoryScope(scope, tier);
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
  const candidate = captureFacadeProposal(SERVICE_PROCEDURE_PROPOSAL, {
    source_type: sourceType,
    proposedMemoryKind: 'sop',
    ...(options.projectId ? { project_id: options.projectId } : {}),
    ...(options.missionId ? { mission_id: options.missionId } : {}),
    task_session_id: options.taskSessionId ?? validated.recording_id,
    title: options.title?.trim() || `Service procedure: ${validated.target.name}`,
    summary:
      options.summary?.trim() ||
      `Review candidate distilled from service recording ${validated.recording_id}; it remains non-executable until human approval.`,
    target_kind: 'procedure',
    ...(options.locale ? { locale: options.locale } : {}),
    evidence_refs: [
      `recording:${validated.recording_id}`,
      `pipeline:${compiled.procedureEntry.procedure_id}`,
    ],
    scope,
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
  return {
    procedure_id: compiled.procedureEntry.procedure_id,
    pipeline: compiled.pipeline,
    preflight,
    candidate,
  };
}
