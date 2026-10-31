/** Immutable offline judgment receipts. Persistence never authorizes or executes a proposal. */
import { z } from 'zod';
import { TraceContext, type Trace } from '../analysis/trace.js';
import { sanitizeIdSegment } from '../foundation/text.js';
import type { ScopeContext } from '../scope-context-validation.js';
import {
  readScopedArtifactAttempt,
  writeScopedArtifactAttempt,
  type ScopedArtifactAttemptAddress,
  type ScopedArtifactAttemptMetadata,
  type ScopedArtifactAttemptResult,
  type ScopedArtifactScope,
} from '../workforce/artifact-store.js';
import {
  judgmentAssessmentSchema,
  judgmentBindingSchema,
  judgmentScopeSchema,
  judgmentModelInputSchema,
  type JudgmentAssessment,
} from './judgment-contract.js';
import { judgmentCanonicalHash, type JudgmentPrecedentSnapshot } from './judgment-precedents.js';
import {
  checkJudgmentContext,
  validateJudgment,
  type JudgmentContextInput,
} from './judgment-validation.js';
import {
  semanticJudgmentModelConfigHash,
  type SemanticJudgmentModelConfig,
  type SemanticJudgmentResult,
  type SemanticJudgmentUsage,
  type SemanticJudgmentDeps,
} from './semantic-judgment.js';

type Evaluated = Extract<JudgmentAssessment, { status: 'evaluated' }>;
type Unavailable = Extract<JudgmentAssessment, { status: 'unavailable' }>;
const fail = (detail: string): Unavailable => ({
  status: 'unavailable',
  reason: 'missing_evidence',
  detail,
});
const key = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim());
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const ordinal = z.number().finite().int().min(1).max(128);
const receiptAddressSchema = z
  .object({ evaluation_key: hash, effect_key: hash, attempt: ordinal, content_hash: hash })
  .strict();
export type JudgmentReceiptAddress = z.infer<typeof receiptAddressSchema>;
const evidenceParentSchema = receiptAddressSchema.pick({ evaluation_key: true, effect_key: true });
export type JudgmentEvidenceParent = z.infer<typeof evidenceParentSchema>;
const parentInputSchema = z
  .object({
    scope: judgmentScopeSchema,
    binding: judgmentBindingSchema,
    effectRef: key,
  })
  .strict();

function canonicalParse<T>(schema: z.ZodType<T>, input: unknown): T {
  const digest = judgmentCanonicalHash(input);
  const parsed = schema.parse(input);
  if (digest !== judgmentCanonicalHash(parsed)) throw new Error('Input is not losslessly encoded');
  return parsed;
}
/** Strict selectors only: no paths, authority, lossy objects or ordinal coercion. */
export function parseJudgmentReceiptAddress(input: unknown): JudgmentReceiptAddress {
  return canonicalParse(receiptAddressSchema, input);
}
/** Full server binding identity; not a receipt reference or execution authorization. */
export function judgmentEvidenceParent(input: {
  scope: unknown;
  binding: unknown;
  effectRef: unknown;
}): JudgmentEvidenceParent {
  const parsed = canonicalParse(parentInputSchema, input);
  const scopeHash = judgmentCanonicalHash(parsed.scope);
  if (parsed.binding.scope_hash !== scopeHash) throw new Error('Binding scope hash differs');
  return Object.freeze({
    evaluation_key: judgmentCanonicalHash(parsed.binding),
    effect_key: judgmentCanonicalHash({
      scope_hash: scopeHash,
      work_ref: parsed.binding.work_ref,
      effect_ref: parsed.effectRef,
    }),
  });
}
const configSchema = z
  .object({
    provider: key,
    model: key,
    maxOutputTokens: z.number().finite().int().min(1).max(4096),
  })
  .strict();
const tokens = z.number().finite().int().min(0).max(1_000_000);
const bodySchema = z
  .object({
    schema_version: z.literal('1'),
    mode: z.literal('offline_fixture'),
    scope: judgmentScopeSchema,
    model_input: judgmentModelInputSchema,
    snapshot: z.unknown(),
    model_config: configSchema,
    parent_token_allowance: tokens,
    required_goal_keys: z.array(key).min(1).max(10),
    known_proposal_keys: z.array(key).min(1).max(10),
    effect_ref: key,
    assessment: judgmentAssessmentSchema,
    usage: z
      .object({
        calls: z.literal(1),
        input_tokens: tokens,
        output_tokens: tokens,
        elapsed_ms: z.number().finite().min(0).max(15_000),
        usage_status: z.literal('reported'),
      })
      .strict(),
  })
  .strict();
type ReceiptBody = Omit<z.infer<typeof bodySchema>, 'scope' | 'snapshot' | 'assessment'> & {
  scope: ScopeContext;
  snapshot: JudgmentPrecedentSnapshot;
  assessment: Evaluated;
};

export interface JudgmentEvidenceRequest {
  context: Omit<JudgmentContextInput, 'expectedBinding' | 'currentSnapshot'>;
  /** Existing server-owned effect identity, kept stable across trigger/model/revision changes. */
  effectRef: string;
  modelConfig: SemanticJudgmentModelConfig;
}
export interface JudgmentEvidenceDeps {
  now(): number;
  readCurrentContext(): ReturnType<SemanticJudgmentDeps['readCurrentContext']>;
  /** Deterministic fixture IDs may be injected; persistence of the sanitized DTO is mandatory. */
  createTrace?: () => Trace;
}
export interface JudgmentEvidenceReference {
  address: JudgmentReceiptAddress;
  artifact_ref: string;
  trace: {
    address: { parent_key: string; effect_key: string; attempt: number; content_hash: string };
    artifact_ref: string;
  };
}
export type JudgmentEvidenceResult =
  | {
      status: 'persisted';
      adopted_existing: boolean;
      reference: JudgmentEvidenceReference;
      assessment: Evaluated;
      usage: SemanticJudgmentUsage;
    }
  | Unavailable;

function artifactScope(scope: JudgmentEvidenceRequest['context']['scope']): ScopedArtifactScope {
  const parsed = judgmentScopeSchema.parse(scope);
  if (parsed.tier !== 'confidential' || !parsed.tenant_slug)
    throw new Error('Offline receipt requires confidential tenant scope');
  const result: ScopedArtifactScope = { tenant: parsed.tenant_slug };
  const fields = {
    organization_id: 'organization',
    project_id: 'project',
    mission_id: 'mission',
    task_id: 'task',
    session_id: 'session',
  } as const;
  for (const [field, target] of Object.entries(fields)) {
    const value = parsed[field as keyof typeof fields];
    if (value !== undefined) {
      if (sanitizeIdSegment(value) !== value)
        throw new Error('Scope reference would be changed by storage sanitization');
      result[target as (typeof fields)[keyof typeof fields]] = value;
    }
  }
  return result;
}
function addressFor(request: JudgmentEvidenceRequest): ScopedArtifactAttemptAddress {
  const parent = judgmentEvidenceParent({
    scope: request.context.scope,
    binding: request.context.binding,
    effectRef: request.effectRef,
  });
  return {
    scope: artifactScope(request.context.scope),
    tier: 'confidential',
    artifact_class: 'evidence',
    namespace: 'semantic-judgment',
    parent_key: parent.evaluation_key,
    effect_key: parent.effect_key,
  };
}

/** Historical integrity only: expired valid records remain readable to allocate a new attempt. */
function historicalBody(raw: unknown, metadata: ScopedArtifactAttemptMetadata): ReceiptBody {
  judgmentCanonicalHash(raw);
  const parsed = bodySchema.parse(raw);
  if (parsed.assessment.status !== 'evaluated')
    throw new Error('Only evaluated receipts can be stored');
  if (judgmentCanonicalHash(raw) !== judgmentCanonicalHash(parsed))
    throw new Error('Receipt is not canonically encoded');
  const body: ReceiptBody = {
    ...parsed,
    scope: judgmentScopeSchema.parse(parsed.scope),
    snapshot: parsed.snapshot as JudgmentPrecedentSnapshot,
    assessment: parsed.assessment,
  };
  const keys = judgmentEvidenceParent({
    scope: body.scope,
    binding: body.assessment.binding,
    effectRef: body.effect_ref,
  });
  if (
    metadata.namespace !== 'semantic-judgment' ||
    metadata.artifact_class !== 'evidence' ||
    metadata.tier !== body.scope.tier ||
    judgmentCanonicalHash(metadata.scope) !== judgmentCanonicalHash(artifactScope(body.scope)) ||
    metadata.parent_key !== keys.evaluation_key ||
    metadata.effect_key !== keys.effect_key ||
    metadata.created_at !== body.assessment.evaluated_at ||
    metadata.expires_at !== body.assessment.expires_at
  )
    throw new Error('Receipt envelope identity differs from its content');
  if (
    semanticJudgmentModelConfigHash(body.model_config) !==
      body.assessment.binding.model_config_hash ||
    body.model_config.provider !== body.assessment.provider ||
    body.model_config.model !== body.assessment.model ||
    body.parent_token_allowance < body.model_config.maxOutputTokens ||
    body.usage.output_tokens > body.model_config.maxOutputTokens ||
    body.usage.input_tokens + body.usage.output_tokens > body.parent_token_allowance
  )
    throw new Error('Receipt configuration or usage is inconsistent');
  const validated = validateJudgment({
    binding: body.assessment.binding,
    expectedBinding: body.assessment.binding,
    scope: body.scope,
    modelInput: body.model_input,
    snapshot: body.snapshot,
    currentSnapshot: { status: 'ready', snapshot: body.snapshot },
    requiredGoalKeys: body.required_goal_keys,
    knownProposalKeys: body.known_proposal_keys,
    verdict: body.assessment.verdict,
  });
  if (
    validated.status !== 'valid' ||
    judgmentCanonicalHash(validated.evidence_refs) !==
      judgmentCanonicalHash(body.assessment.evidence_refs)
  )
    throw new Error('Receipt evidence is not reconstructable');
  return raw as ReceiptBody;
}
function currentBody(
  body: ReceiptBody,
  request: JudgmentEvidenceRequest,
  deps: JudgmentEvidenceDeps
): Unavailable | null {
  const now = deps.now();
  if (
    !Number.isFinite(now) ||
    now < Date.parse(body.assessment.evaluated_at) ||
    now >= Date.parse(body.assessment.expires_at)
  )
    return fail('Receipt is expired or the clock precedes its creation');
  if (
    judgmentCanonicalHash(body.scope) !== judgmentCanonicalHash(request.context.scope) ||
    body.effect_ref !== request.effectRef ||
    judgmentCanonicalHash(body.model_config) !==
      judgmentCanonicalHash(configSchema.parse(request.modelConfig))
  )
    return fail('Receipt scope, effect or model configuration differs');
  const current = deps.readCurrentContext();
  const checked = validateJudgment({
    ...request.context,
    ...current,
    binding: body.assessment.binding,
    modelInput: body.model_input,
    snapshot: body.snapshot,
    verdict: body.assessment.verdict,
  });
  if (checked.status === 'unavailable') return checked;
  const completed = deps.now();
  if (
    !Number.isFinite(completed) ||
    completed < Date.parse(body.assessment.evaluated_at) ||
    completed >= Date.parse(body.assessment.expires_at)
  )
    return fail('Receipt expired or the clock regressed during current evidence validation');
  return null;
}
function preflight(
  request: JudgmentEvidenceRequest,
  deps: JudgmentEvidenceDeps
): Unavailable | null {
  const configHash = semanticJudgmentModelConfigHash(request.modelConfig);
  const checked = checkJudgmentContext({ ...request.context, ...deps.readCurrentContext() });
  if (checked.status === 'unavailable') return checked;
  if ((request.context.binding as Evaluated['binding']).model_config_hash !== configHash)
    return fail('Requested model configuration is not bound');
  addressFor(request);
  return null;
}

const traceSchema = z
  .object({
    schema_version: z.literal('1'),
    trace_id: key,
    span_id: key,
    recorded_at: z.string().datetime(),
    scope_hash: hash,
    work_ref: key,
    evaluation_key: hash,
    effect_key: hash,
    receipt_attempt: ordinal,
    receipt_content_hash: hash,
    receipt_ref: z.string().min(1).max(2048),
  })
  .strict();
type ReceiptTrace = z.infer<typeof traceSchema>;
function traceAddress(
  receipt: ScopedArtifactAttemptResult<ReceiptBody>
): ScopedArtifactAttemptAddress {
  return {
    scope: receipt.envelope.scope,
    tier: receipt.envelope.tier,
    artifact_class: 'log',
    namespace: 'semantic-judgment-trace',
    parent_key: judgmentCanonicalHash({
      evaluation_key: receipt.envelope.parent_key,
      receipt_attempt: receipt.attempt,
      receipt_content_hash: receipt.envelope.content_hash,
    }),
    effect_key: receipt.envelope.effect_key,
  };
}
function traceValidator(receipt: ScopedArtifactAttemptResult<ReceiptBody>) {
  const expected = traceAddress(receipt);
  return (raw: unknown, metadata: ScopedArtifactAttemptMetadata): ReceiptTrace => {
    judgmentCanonicalHash(raw);
    const trace = traceSchema.parse(raw);
    if (
      judgmentCanonicalHash(raw) !== judgmentCanonicalHash(trace) ||
      metadata.namespace !== expected.namespace ||
      metadata.artifact_class !== 'log' ||
      metadata.parent_key !== expected.parent_key ||
      metadata.effect_key !== expected.effect_key ||
      metadata.tier !== expected.tier ||
      judgmentCanonicalHash(metadata.scope) !== judgmentCanonicalHash(expected.scope) ||
      metadata.created_at !== receipt.envelope.created_at ||
      metadata.expires_at !== receipt.envelope.expires_at ||
      trace.scope_hash !== receipt.envelope.content.assessment.binding.scope_hash ||
      trace.work_ref !== receipt.envelope.content.assessment.binding.work_ref ||
      trace.evaluation_key !== receipt.envelope.parent_key ||
      trace.effect_key !== receipt.envelope.effect_key ||
      trace.receipt_attempt !== receipt.attempt ||
      trace.receipt_content_hash !== receipt.envelope.content_hash ||
      trace.receipt_ref !== receipt.artifact.repo_relative_path ||
      Date.parse(trace.recorded_at) < Date.parse(metadata.created_at) ||
      Date.parse(trace.recorded_at) >= Date.parse(metadata.expires_at)
    )
      throw new Error('Trace does not belong to this receipt');
    return raw as ReceiptTrace;
  };
}
function persistReceiptTrace(
  receipt: ScopedArtifactAttemptResult<ReceiptBody>,
  deps: JudgmentEvidenceDeps
) {
  const context = new TraceContext('semantic-judgment-receipt', {
    correlationId: receipt.envelope.content.assessment.binding.work_ref,
  });
  const trace = deps.createTrace?.() ?? context.finalize();
  // Whitelist a supported receipt-trace DTO. Ambient customer/tenant or arbitrary trace fields
  // never enter the artifact; no persistTrace/exporter is called.
  const dto: ReceiptTrace = {
    schema_version: '1',
    trace_id: trace.traceId,
    span_id: trace.rootSpan.spanId,
    recorded_at: new Date(deps.now()).toISOString(),
    scope_hash: receipt.envelope.content.assessment.binding.scope_hash,
    work_ref: receipt.envelope.content.assessment.binding.work_ref,
    evaluation_key: receipt.envelope.parent_key,
    effect_key: receipt.envelope.effect_key,
    receipt_attempt: receipt.attempt,
    receipt_content_hash: receipt.envelope.content_hash,
    receipt_ref: receipt.artifact.repo_relative_path,
  };
  return writeScopedArtifactAttempt({
    ...traceAddress(receipt),
    content: dto,
    created_at: receipt.envelope.created_at,
    expires_at: receipt.envelope.expires_at,
    now: deps.now,
    validateContent: traceValidator(receipt),
  });
}
function latestReceipt(request: JudgmentEvidenceRequest) {
  return readScopedArtifactAttempt({ ...addressFor(request), validateContent: historicalBody });
}
function finish(
  receipt: ScopedArtifactAttemptResult<ReceiptBody>,
  request: JudgmentEvidenceRequest,
  deps: JudgmentEvidenceDeps
): JudgmentEvidenceResult {
  const before = currentBody(receipt.envelope.content, request, deps);
  if (before) return before;
  const trace = persistReceiptTrace(receipt, deps);
  const latest = latestReceipt(request);
  if (
    !latest ||
    latest.attempt !== receipt.attempt ||
    latest.envelope.content_hash !== receipt.envelope.content_hash
  )
    return fail('Receipt has been replaced by a later attempt');
  const after = currentBody(latest.envelope.content, request, deps);
  if (after) return after;
  return {
    status: 'persisted',
    adopted_existing: receipt.adopted_existing,
    reference: {
      address: {
        evaluation_key: receipt.envelope.parent_key,
        effect_key: receipt.envelope.effect_key,
        attempt: receipt.attempt,
        content_hash: receipt.envelope.content_hash,
      },
      artifact_ref: receipt.artifact.repo_relative_path,
      trace: {
        address: {
          parent_key: trace.envelope.parent_key,
          effect_key: trace.envelope.effect_key,
          attempt: trace.attempt,
          content_hash: trace.envelope.content_hash,
        },
        artifact_ref: trace.artifact.repo_relative_path,
      },
    },
    assessment: receipt.envelope.content.assessment,
    usage: receipt.envelope.content.usage,
  };
}

/** The facade can adopt a different valid winner; neither receipt nor trace is overwritten. */
export function saveJudgmentEvidence(
  request: JudgmentEvidenceRequest & {
    result: SemanticJudgmentResult;
    parentTokenAllowance: number;
  },
  deps: JudgmentEvidenceDeps
): JudgmentEvidenceResult {
  try {
    const refused = preflight(request, deps);
    if (refused) return refused;
    if (request.result.assessment.status !== 'evaluated')
      return fail('An unavailable judgment cannot be persisted as evaluated');
    const body: ReceiptBody = {
      schema_version: '1',
      mode: 'offline_fixture',
      scope: request.context.scope,
      model_input: judgmentModelInputSchema.parse(request.context.modelInput),
      snapshot: request.context.snapshot,
      model_config: request.modelConfig,
      parent_token_allowance: request.parentTokenAllowance,
      required_goal_keys: [...request.context.requiredGoalKeys],
      known_proposal_keys: [...request.context.knownProposalKeys],
      effect_ref: request.effectRef,
      assessment: request.result.assessment,
      usage: bodySchema.shape.usage.parse(request.result.usage),
    };
    const before = currentBody(body, request, deps);
    if (before) return before;
    const receipt = writeScopedArtifactAttempt({
      ...addressFor(request),
      content: body,
      created_at: body.assessment.evaluated_at,
      expires_at: body.assessment.expires_at,
      now: deps.now,
      validateContent: historicalBody,
    });
    return finish(receipt, request, deps);
  } catch {
    return fail('Receipt or required trace could not be validated and registered');
  }
}

/** Explicit references are selectors and hashes, never file paths or authority. Latest only. */
export function reuseJudgmentEvidence(
  request: JudgmentEvidenceRequest & { address: JudgmentReceiptAddress },
  deps: JudgmentEvidenceDeps
): JudgmentEvidenceResult {
  try {
    const refused = preflight(request, deps);
    if (refused) return refused;
    const address = parseJudgmentReceiptAddress(request.address);
    const expected = addressFor(request);
    if (
      address.evaluation_key !== expected.parent_key ||
      address.effect_key !== expected.effect_key
    )
      return fail('Receipt reference belongs to another evaluation or effect');
    const latest = latestReceipt(request);
    if (
      !latest ||
      latest.attempt !== address.attempt ||
      latest.envelope.content_hash !== address.content_hash
    )
      return fail('Receipt reference is not the latest allocated content');
    return finish(latest, request, deps);
  } catch {
    return fail('Receipt or required trace could not be validated and registered');
  }
}

/**
 * Resolve the current valid latest attempt for a server-bound parent. No receipt is allocated,
 * overwritten or extended. This may create or repair the mandatory trace; it is not read-only.
 * A valid verdict remains evidence, never apply authority.
 */
export function resolveLatestJudgmentEvidence(
  request: JudgmentEvidenceRequest & { parent: JudgmentEvidenceParent },
  deps: JudgmentEvidenceDeps
): JudgmentEvidenceResult {
  try {
    const parent = canonicalParse(evidenceParentSchema, request.parent);
    const expected = judgmentEvidenceParent({
      scope: request.context.scope,
      binding: request.context.binding,
      effectRef: request.effectRef,
    });
    if (judgmentCanonicalHash(parent) !== judgmentCanonicalHash(expected))
      return fail('Receipt parent belongs to another evaluation or effect');
    const refused = preflight(request, deps);
    if (refused) return refused;
    const latest = latestReceipt(request);
    if (!latest) return fail('No persisted receipt exists for this evaluation');
    return finish(latest, request, deps);
  } catch {
    return fail('Receipt or required trace could not be validated and registered');
  }
}

export type HistoricalJudgmentEvidenceResult =
  | {
      status: 'historical_verified';
      address: JudgmentReceiptAddress;
      assessment: Evaluated;
      model_input: ReturnType<typeof judgmentModelInputSchema.parse>;
    }
  | Unavailable;

/**
 * Immutable scoped payload/hash/binding integrity only. This proves neither a prior successful
 * adoption (its trace or final current check may have failed), nor freshness or approval.
 * Expired historical attempts remain auditable. This reader never repairs or creates artifacts.
 */
export function readHistoricalJudgmentEvidence(input: {
  scope: unknown;
  binding: unknown;
  effectRef: unknown;
  address: unknown;
}): HistoricalJudgmentEvidenceResult {
  try {
    const parsed = canonicalParse(
      parentInputSchema.extend({ address: receiptAddressSchema }),
      input
    );
    const parent = judgmentEvidenceParent({
      scope: parsed.scope,
      binding: parsed.binding,
      effectRef: parsed.effectRef,
    });
    if (
      parsed.address.evaluation_key !== parent.evaluation_key ||
      parsed.address.effect_key !== parent.effect_key
    )
      return fail('Historical receipt belongs to another evaluation or effect');
    const receipt = readScopedArtifactAttempt({
      scope: artifactScope(parsed.scope),
      tier: 'confidential',
      artifact_class: 'evidence',
      namespace: 'semantic-judgment',
      parent_key: parent.evaluation_key,
      effect_key: parent.effect_key,
      attempt: parsed.address.attempt,
      validateContent: historicalBody,
    });
    if (
      !receipt ||
      receipt.envelope.content_hash !== parsed.address.content_hash ||
      judgmentCanonicalHash(receipt.envelope.content.assessment.binding) !==
        judgmentCanonicalHash(parsed.binding) ||
      judgmentCanonicalHash(receipt.envelope.content.scope) !==
        judgmentCanonicalHash(parsed.scope) ||
      receipt.envelope.content.effect_ref !== parsed.effectRef
    )
      return fail('Historical receipt payload or binding differs');
    const result = structuredClone({
      status: 'historical_verified' as const,
      address: parsed.address,
      assessment: receipt.envelope.content.assessment,
      model_input: receipt.envelope.content.model_input,
    });
    const freeze = (value: object): void => {
      for (const child of Object.values(value))
        if (child && typeof child === 'object') freeze(child);
      Object.freeze(value);
    };
    freeze(result);
    return result;
  } catch {
    return fail('Historical receipt integrity could not be verified');
  }
}
