export type OutcomeVerificationMethod = 'self_check' | 'review_gate' | 'human_acceptance' | 'test';

export interface VisionRefSummary {
  raw: string;
  kind: 'company' | 'vision' | 'legacy';
  tenant_slug: string | null;
  path: string | null;
  query: string | null;
}

export interface OutcomeContract {
  outcome_id: string;
  requested_result: string;
  deliverable_kind: string;
  success_criteria: string[];
  evidence_required: boolean;
  expected_artifacts: Array<{ kind: string; storage_class: string }>;
  verification_method: OutcomeVerificationMethod;
  vision_ref?: VisionRefSummary | null;
}

export interface OutcomeCompletionInput {
  artifactRefs?: Array<string | undefined | null>;
}

export function createOutcomeContract(input: {
  outcomeId?: string;
  requestedResult: string;
  deliverableKind: string;
  successCriteria?: string[];
  evidenceRequired?: boolean;
  expectedArtifacts?: Array<{ kind: string; storage_class: string }>;
  verificationMethod?: OutcomeVerificationMethod;
  visionRef?: string | VisionRefSummary | null;
  tenantSlug?: string | null;
}): OutcomeContract {
  const successCriteria = (input.successCriteria || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const expectedArtifacts = (input.expectedArtifacts || [])
    .filter((item) => item && item.kind && item.storage_class)
    .map((item) => ({ kind: item.kind, storage_class: item.storage_class }));
  const vision_ref =
    typeof input.visionRef === 'string'
      ? parseVisionRef(input.visionRef, input.tenantSlug ?? null)
      : input.visionRef || null;

  return {
    outcome_id: input.outcomeId || `outcome_${Date.now().toString(36)}`,
    requested_result: String(input.requestedResult || '').trim(),
    deliverable_kind: String(input.deliverableKind || '').trim(),
    success_criteria: successCriteria,
    evidence_required: Boolean(input.evidenceRequired),
    expected_artifacts: expectedArtifacts,
    verification_method: input.verificationMethod || 'self_check',
    ...(vision_ref ? { vision_ref } : {}),
  };
}

function parseVisionRef(input: string, tenantSlug?: string | null): VisionRefSummary {
  const raw = String(input || '').trim();
  if (!raw) {
    return {
      raw: '',
      kind: 'legacy',
      tenant_slug: tenantSlug?.trim() || null,
      path: null,
      query: null,
    };
  }
  if (raw.startsWith('company://')) {
    const remainder = raw.slice('company://'.length);
    const [pathPart, queryPart] = remainder.split('?', 2);
    const [parsedTenantSlug, ...segments] = pathPart.split('/').filter(Boolean);
    return {
      raw,
      kind: 'company',
      tenant_slug: parsedTenantSlug || tenantSlug?.trim() || null,
      path: segments.length ? segments.join('/') : 'vision',
      query: queryPart || null,
    };
  }
  if (raw.startsWith('vision://')) {
    const remainder = raw.slice('vision://'.length);
    const [pathPart, queryPart] = remainder.split('?', 2);
    return {
      raw,
      kind: 'vision',
      tenant_slug: tenantSlug?.trim() || null,
      path: pathPart || null,
      query: queryPart || null,
    };
  }
  return {
    raw,
    kind: 'legacy',
    tenant_slug: tenantSlug?.trim() || null,
    path: null,
    query: null,
  };
}

export function validateOutcomeContractAtCompletion(
  contract: OutcomeContract,
  input: OutcomeCompletionInput = {}
): { ok: boolean; reason?: string } {
  if (!Array.isArray(contract.success_criteria) || contract.success_criteria.length === 0) {
    return { ok: false, reason: 'Outcome contract must include at least one success criterion.' };
  }

  if (contract.evidence_required) {
    const hasEvidence = (input.artifactRefs || []).some(
      (value) => String(value || '').trim().length > 0
    );
    if (!hasEvidence) {
      return {
        ok: false,
        reason: 'Outcome contract requires evidence, but no artifact reference was provided.',
      };
    }
  }

  return { ok: true };
}

export function inferTaskSessionOutcomeContract(input: {
  sessionId: string;
  goal: { summary: string; success_condition: string };
  taskType: string;
}): OutcomeContract {
  const artifactByTaskType: Record<string, { kind: string; storage: string }> = {
    presentation_deck: { kind: 'pptx', storage: 'artifact_store' },
    report_document: { kind: 'docx', storage: 'artifact_store' },
    workbook_wbs: { kind: 'xlsx', storage: 'artifact_store' },
    capture_photo: { kind: 'image', storage: 'artifact_store' },
  };
  const mapped = artifactByTaskType[input.taskType];
  const deliverableKind = mapped ? mapped.kind : 'summary';
  const expectedArtifacts = mapped ? [{ kind: mapped.kind, storage_class: mapped.storage }] : [];

  return createOutcomeContract({
    outcomeId: `ts_${input.sessionId}`,
    requestedResult: input.goal.summary,
    deliverableKind,
    successCriteria: [input.goal.success_condition],
    evidenceRequired: false,
    expectedArtifacts,
    verificationMethod: 'self_check',
  });
}

export function inferMissionOutcomeContract(input: {
  missionId: string;
  missionType?: string;
  visionRef?: string;
  /**
   * IL-01: interpreted intent goal from the surface. When present, the
   * contract reflects the actual user request instead of the generic
   * per-type placeholder.
   */
  intentGoal?: {
    source_text?: string;
    summary?: string;
    success_condition?: string;
  };
}): OutcomeContract {
  const missionType = String(input.missionType || 'development');
  const goalSummary = input.intentGoal?.summary?.trim();
  const goalSource = input.intentGoal?.source_text?.trim();
  const successCondition = input.intentGoal?.success_condition?.trim();

  const requestedResult =
    goalSummary ||
    goalSource ||
    (input.visionRef
      ? `Deliver mission outcome aligned to ${input.visionRef}`
      : `Complete mission scope for type ${missionType}`);
  const successCriteria =
    (goalSummary || goalSource) && successCondition
      ? [successCondition]
      : ['Mission lifecycle reaches completed with verification and distillation.'];

  return createOutcomeContract({
    outcomeId: `msn_${input.missionId}`,
    requestedResult,
    deliverableKind: missionType,
    successCriteria,
    evidenceRequired: false,
    expectedArtifacts: [],
    verificationMethod: 'review_gate',
    visionRef: input.visionRef,
  });
}
