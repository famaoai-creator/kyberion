import { compileSchema } from './foundation/ajv.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import type { ArtifactKind } from './workforce/artifact-registry.js';

const ARTIFACT_KIND_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/artifact-kind.schema.json'
);
let artifactKindValidator: ((value: unknown) => boolean) | undefined;

function isArtifactKind(value: unknown): value is ArtifactKind {
  artifactKindValidator ??= compileSchema(ARTIFACT_KIND_SCHEMA_PATH);
  return artifactKindValidator(value);
}

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
  /** Constrained to the outcome-catalog正本 vocabulary (ArtifactKind union). */
  deliverable_kind: ArtifactKind;
  success_criteria: string[];
  evidence_required: boolean;
  expected_artifacts: Array<{ kind: ArtifactKind; storage_class: string }>;
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
    deliverable_kind: normalizeArtifactKind(input.deliverableKind),
    success_criteria: successCriteria,
    evidence_required: Boolean(input.evidenceRequired),
    expected_artifacts: expectedArtifacts.map((item) => ({
      kind: normalizeArtifactKind(item.kind),
      storage_class: item.storage_class,
    })),
    verification_method: input.verificationMethod || 'self_check',
    ...(vision_ref ? { vision_ref } : {}),
  };
}

/**
 * D6: tasktype→artifact-kind catalog.
 * 正本: knowledge/product/governance/tasktype-artifact-map.json
 * (schema: knowledge/product/schemas/tasktype-artifact-map.schema.json).
 * libs/core/workforce/work-design.ts の outcomeCatalog (defineCatalog) とは
 * outcome-catalog.json を共有正本とし、こちらは tasktype 解決のみを持つ。
 * 解決結果・デフォルトは従来の直書きマップと同一。
 */
export interface TasktypeArtifactMapping {
  kind: ArtifactKind;
  storage_class: string;
}

interface TasktypeArtifactMapFile {
  version?: string | number;
  mappings?: Record<string, TasktypeArtifactMapping>;
  fallback?: { kind?: ArtifactKind };
}

interface OutcomeCatalogFile {
  outcomes?: Record<string, { deliverable_kind?: ArtifactKind }>;
}

const tasktypeArtifactCatalog = defineCatalog<TasktypeArtifactMapFile>({
  id: 'tasktype-artifact-map',
  path: pathResolver.knowledge('product/governance/tasktype-artifact-map.json'),
  schema: pathResolver.knowledge('product/schemas/tasktype-artifact-map.schema.json'),
});

const outcomeCatalogForResolution = defineCatalog<OutcomeCatalogFile>({
  id: 'outcome-catalog',
  path: pathResolver.knowledge('product/governance/outcome-catalog.json'),
  schema: pathResolver.knowledge('product/schemas/outcome-catalog.schema.json'),
});

function loadTasktypeArtifactMap(): {
  mappings: Record<string, TasktypeArtifactMapping>;
  fallbackKind: ArtifactKind;
} {
  const parsed = tasktypeArtifactCatalog.load();
  return {
    mappings: parsed.mappings || {},
    fallbackKind: parsed.fallback!.kind!,
  };
}

/** Resolve a task_type to its governed artifact mapping; null when unmapped. */
export function resolveTaskTypeArtifact(taskType: string): TasktypeArtifactMapping | null {
  const normalized = String(taskType || '').trim();
  if (!normalized) return null;
  const mapped = loadTasktypeArtifactMap().mappings[normalized];
  if (!mapped || !mapped.kind || !mapped.storage_class) return null;
  return { kind: mapped.kind, storage_class: mapped.storage_class };
}

/** Fallback deliverable kind for task types without a catalog mapping (default: summary). */
export function resolveTaskTypeFallbackKind(): ArtifactKind {
  return loadTasktypeArtifactMap().fallbackKind;
}

/**
 * Resolve a missionType to a governed deliverable kind via outcome-catalog.json:
 * outcome-id 一致 → その deliverable_kind、
 * deliverable_kind 語彙一致 → そのまま、
 * 既知の legacy mission type は保持し、未知語彙は governed fallback に解決する。
 */
export function resolveMissionDeliverableKind(missionType: string): ArtifactKind {
  const normalized = String(missionType || 'development').trim() || 'development';
  try {
    const outcomes = outcomeCatalogForResolution.load().outcomes || {};
    const byId = outcomes[normalized];
    if (byId?.deliverable_kind) return byId.deliverable_kind;
    if (Object.values(outcomes).some((entry) => entry?.deliverable_kind === normalized)) {
      if (isArtifactKind(normalized)) return normalized;
    }
  } catch {
    // Catalog unavailable: preserve the legacy pass-through below.
  }
  return isArtifactKind(normalized) ? normalized : resolveTaskTypeFallbackKind();
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
  const mapped = resolveTaskTypeArtifact(input.taskType);
  const deliverableKind: ArtifactKind = mapped ? mapped.kind : resolveTaskTypeFallbackKind();
  const expectedArtifacts: Array<{ kind: ArtifactKind; storage_class: string }> = mapped
    ? [{ kind: mapped.kind, storage_class: mapped.storage_class }]
    : [];

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
    deliverableKind: resolveMissionDeliverableKind(missionType),
    successCriteria,
    evidenceRequired: false,
    expectedArtifacts: [],
    verificationMethod: 'review_gate',
    visionRef: input.visionRef,
  });
}

function normalizeArtifactKind(value: string): ArtifactKind {
  const normalized = String(value || '').trim();
  if (!isArtifactKind(normalized))
    throw new Error(`[ARTIFACT_KIND_INVALID] Unsupported artifact kind: ${normalized}`);
  return normalized;
}
