import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';

import {
  computeApprovalPayloadHash,
  createApprovalRequest,
  loadApprovalRequest,
  recordApprovalApplyResult,
  type ApprovalRequestRecord,
} from './governance/approval-store.js';
import { withExecutionContext } from './governance.js';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import {
  loadResolvedStandardIntentCatalog,
  type IntentResolutionPacket,
  type StandardIntentDefinition,
} from './intent/intent-resolution.js';
import {
  loadPipelineRunJournal,
  type PipelineRunJournalState,
} from './pipeline/pipeline-run-journal.js';
import { pathResolver } from './path-resolver.js';
import type { ScopeContext } from './scope-context.js';
import { assertScopeContext } from './scope-context-validation.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
} from './secure-io.js';

export type AcceptedPipelineBindingStatus = 'candidate' | 'active' | 'deprecated' | 'revoked';

export interface AcceptedPipelineBindingScope {
  tier: 'public' | 'confidential' | 'personal';
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
}

export interface AcceptedPipelineRunEvidence {
  pipeline_sha256: string;
  completed_at: string;
  evidence_digest: string;
}

export interface AcceptedPipelineBinding {
  binding_id: string;
  pipeline_ref: string;
  intent_ids: string[];
  scope: AcceptedPipelineBindingScope;
  successful_run_evidence: AcceptedPipelineRunEvidence;
  approval_request_id: string;
  accepted_at: string;
  status: AcceptedPipelineBindingStatus;
}

export interface AcceptedPipelineBindingCatalogFile {
  version: number;
  bindings: AcceptedPipelineBinding[];
}

export interface PipelineBindingEffect {
  pipeline_ref: string;
  intent_id: string;
  scope: AcceptedPipelineBindingScope;
  successful_run_id: string;
  pipeline_sha256: string;
}

export interface PipelineBindingRequestInput {
  pipeline_ref: string;
  intent_id: string;
  scope: AcceptedPipelineBindingScope;
  successful_run_id: string;
  channel?: string;
  requested_by?: string;
}

export interface AcceptPromotedPipelineBindingInput extends PipelineBindingRequestInput {
  approval_request_id: string;
  approval_storage_channel?: string;
}

const PUBLIC_CATALOG_PATH = 'knowledge/product/orchestration/accepted-pipeline-bindings.json';
const CATALOG_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/accepted-pipeline-bindings.schema.json'
);
export const PIPELINE_BINDING_APPROVAL_CHANNEL = 'pipeline-binding';
export const PIPELINE_BINDING_EFFECT = 'accepted-pipeline-binding:v1';
const catalogCache = new Map<string, GovernedCatalog<AcceptedPipelineBindingCatalogFile>>();

function catalogForPath(relativePath: string): GovernedCatalog<AcceptedPipelineBindingCatalogFile> {
  const safePath = assertSafeRepositoryPath(pathResolver.rootResolve(relativePath), {
    allowMissingLeaf: true,
  });
  let cached = catalogCache.get(safePath);
  if (!cached) {
    cached = defineCatalog<AcceptedPipelineBindingCatalogFile>({
      id: `accepted-pipeline-bindings:${relativePath}`,
      path: safePath,
      schema: CATALOG_SCHEMA_PATH,
      fallback: { version: 1, bindings: [] },
    });
    catalogCache.set(safePath, cached);
  }
  return cached;
}

function normalizePipelineRef(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/');
  if (!/^pipelines\/[a-z0-9][a-z0-9._-]*\.json$/u.test(normalized)) {
    throw new Error(
      '[PIPELINE_BINDING_INVALID] pipeline_ref must name a root promoted pipelines/*.json file'
    );
  }
  return normalized;
}

function normalizedScope(input: AcceptedPipelineBindingScope): AcceptedPipelineBindingScope {
  const scope = assertScopeContext(
    { ...input, tier: input.tier },
    { requireTenant: input.tier === 'confidential', allowShared: false }
  );
  return {
    tier: scope.tier,
    ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
    ...(scope.organization_id ? { organization_id: scope.organization_id } : {}),
    ...(scope.project_id ? { project_id: scope.project_id } : {}),
  };
}

export function acceptedPipelineBindingCatalogPath(scope: AcceptedPipelineBindingScope): string {
  const pathSegment = (value: string, label: string): string => {
    const normalized = value.trim();
    if (!normalized || normalized === '.' || normalized === '..') {
      throw new Error(`[PIPELINE_BINDING_INVALID] invalid ${label}`);
    }
    return encodeURIComponent(normalized);
  };
  if (scope.tier === 'public') {
    if (scope.tenant_slug || scope.organization_id || scope.project_id) {
      throw new Error('[PIPELINE_BINDING_INVALID] public binding scope cannot contain private IDs');
    }
    return PUBLIC_CATALOG_PATH;
  }
  const suffix = [
    scope.organization_id
      ? `organizations/${pathSegment(scope.organization_id, 'organization_id')}`
      : undefined,
    scope.project_id ? `projects/${pathSegment(scope.project_id, 'project_id')}` : undefined,
    'accepted-pipeline-bindings.json',
  ]
    .filter((segment): segment is string => Boolean(segment))
    .join('/');
  if (scope.tier === 'confidential') {
    return `knowledge/confidential/${scope.tenant_slug}/orchestration/${suffix}`;
  }
  const personalTenant = scope.tenant_slug
    ? `tenants/${pathSegment(scope.tenant_slug, 'tenant_slug')}/`
    : '';
  return `knowledge/personal/orchestration/${personalTenant}${suffix}`;
}

export function validateAcceptedBindingCatalogScope(
  bindingCatalog: AcceptedPipelineBindingCatalogFile,
  scope: AcceptedPipelineBindingScope
): void {
  if (
    bindingCatalog.bindings.some((binding) => !scopeMatches(binding.scope, scope as ScopeContext))
  ) {
    throw new Error('[PIPELINE_BINDING_INVALID] scoped catalog contains a foreign-scope binding');
  }
}

function pipelineBytes(pipelineRef: string): Buffer {
  const pipelinePath = assertSafeRepositoryPath(pathResolver.rootResolve(pipelineRef));
  if (!safeExistsSync(pipelinePath) || !safeLstat(pipelinePath).isFile()) {
    throw new Error(`[PIPELINE_BINDING_INVALID] pipeline is not an existing regular file`);
  }
  return safeReadFile(pipelinePath) as Buffer;
}

export function hashAcceptedPipeline(pipelineRef: string): string {
  return createHash('sha256')
    .update(pipelineBytes(normalizePipelineRef(pipelineRef)))
    .digest('hex');
}

function loadPromotedPipeline(pipelineRef: string): Record<string, unknown> {
  const raw = pipelineBytes(pipelineRef).toString('utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed.promotion || typeof parsed.promotion !== 'object') {
    throw new Error(
      `[PIPELINE_BINDING_INVALID] ${pipelineRef} is not a pipeline:promote candidate`
    );
  }
  return parsed;
}

function requirePipelineIntent(
  intentId: string,
  scope: AcceptedPipelineBindingScope
): StandardIntentDefinition {
  const intent = loadResolvedStandardIntentCatalog({
    tier: scope.tier,
    tenantId: scope.tenant_slug,
  }).find((candidate) => candidate.id === intentId);
  if (!intent) throw new Error(`[PIPELINE_BINDING_INVALID] unknown intent ID: ${intentId}`);
  if (intent.resolution?.shape !== 'pipeline' || intent.execution_shape !== 'pipeline') {
    throw new Error(`[PIPELINE_BINDING_INVALID] intent ${intentId} is not pipeline-shaped`);
  }
  return intent;
}

function requireSuccessfulRun(
  pipelineRef: string,
  runId: string,
  pipelineSha256: string
): AcceptedPipelineRunEvidence {
  const state = loadPipelineRunJournal(runId);
  return validateAcceptedPipelineRunState(state, pipelineRef, pipelineSha256);
}

export function validateAcceptedPipelineRunState(
  state: PipelineRunJournalState,
  pipelineRef: string,
  pipelineSha256: string
): AcceptedPipelineRunEvidence {
  const relativeJournal = pathResolver.toRepoRelative(state.path).replaceAll('\\', '/');
  const governedRoot =
    /^active\/shared\/runtime\/pipeline-runs\/[A-Za-z0-9._-]+\.jsonl$/u.test(relativeJournal) ||
    /^active\/missions\/(?:public|confidential|personal)\/.+\/coordination\/pipeline-runs\/[A-Za-z0-9._-]+\.jsonl$/u.test(
      relativeJournal
    );
  if (!governedRoot) {
    throw new Error('[PIPELINE_BINDING_INVALID] run evidence is outside governed journal roots');
  }
  const startedPath = pathResolver
    .toRepoRelative(pathResolver.rootResolve(String(state.started?.input_path || '')))
    .replaceAll('\\', '/');
  if (startedPath !== pipelineRef) {
    throw new Error('[PIPELINE_BINDING_INVALID] run input_path does not match pipeline_ref');
  }
  if (state.started?.pipeline_sha256 !== pipelineSha256) {
    throw new Error(
      '[PIPELINE_BINDING_INVALID] pipeline content hash does not match successful run'
    );
  }
  if (state.finished?.status !== 'succeeded' || state.suspended) {
    throw new Error('[PIPELINE_BINDING_INVALID] pipeline run did not finish successfully');
  }
  const completedAt =
    [...state.events].reverse().find((event) => event.event === 'run_finished')?.timestamp || '';
  return {
    pipeline_sha256: pipelineSha256,
    completed_at: completedAt,
    evidence_digest: createHash('sha256')
      .update(`${state.run_id}\0${completedAt}\0${pipelineSha256}`, 'utf8')
      .digest('hex'),
  };
}

export function buildPipelineBindingEffect(
  input: PipelineBindingRequestInput
): PipelineBindingEffect {
  const pipelineRef = normalizePipelineRef(input.pipeline_ref);
  loadPromotedPipeline(pipelineRef);
  const scope = normalizedScope(input.scope);
  const intentId = input.intent_id.trim();
  requirePipelineIntent(intentId, scope);
  const pipelineSha256 = hashAcceptedPipeline(pipelineRef);
  requireSuccessfulRun(pipelineRef, input.successful_run_id, pipelineSha256);
  return {
    pipeline_ref: pipelineRef,
    intent_id: intentId,
    scope,
    successful_run_id: input.successful_run_id.trim(),
    pipeline_sha256: pipelineSha256,
  };
}

export function requestPipelineBindingApproval(
  input: PipelineBindingRequestInput
): ApprovalRequestRecord {
  const effect = buildPipelineBindingEffect(input);
  const payloadHash = computeApprovalPayloadHash({ ...effect });
  const channel = input.channel?.trim() || PIPELINE_BINDING_APPROVAL_CHANNEL;
  return createApprovalRequest('mission_controller', {
    channel,
    storageChannel: PIPELINE_BINDING_APPROVAL_CHANNEL,
    threadTs: `pipeline-binding:${effect.pipeline_sha256.slice(0, 12)}`,
    correlationId: `pipeline-binding:${payloadHash}`,
    requestedBy: input.requested_by?.trim() || 'pipeline-binding-cli',
    requestedByContext: {
      surface: 'terminal',
      actorId: input.requested_by?.trim() || 'pipeline-binding-cli',
      actorRole: 'operator',
      pipelineRunId: effect.successful_run_id,
    },
    draft: {
      title: `Accept pipeline binding for ${effect.intent_id}`,
      summary: `Bind ${effect.pipeline_ref} to ${effect.intent_id} in ${effect.scope.tier} scope`,
      severity: 'high',
    },
    justification: {
      reason: 'Human acceptance is required before deterministic intent routing is enabled.',
      evidence: [`pipeline-run:${effect.successful_run_id}`, `sha256:${effect.pipeline_sha256}`],
      requestedEffects: [PIPELINE_BINDING_EFFECT],
    },
    risk: {
      level: 'high',
      restartScope: 'none',
      requiresStrongAuth: true,
      policyId: PIPELINE_BINDING_EFFECT,
    },
    accountability: {
      finalDecision: 'human_only',
      payloadHash,
      effectBinding: PIPELINE_BINDING_EFFECT,
    },
    scope: effect.scope,
  });
}

export function validatePipelineBindingApproval(
  approval: ApprovalRequestRecord | null,
  expectedPayloadHash: string
): ApprovalRequestRecord {
  if (!approval) throw new Error('[PIPELINE_BINDING_INVALID] approval request not found');
  if (approval.status !== 'approved' && approval.status !== 'applied') {
    throw new Error('[PIPELINE_BINDING_INVALID] approval request is not approved');
  }
  if (
    approval.decidedByType !== 'human' ||
    approval.authenticated !== true ||
    !approval.decidedBy ||
    !approval.decidedAuthMethod ||
    approval.decidedAuthMethod === 'local_token'
  ) {
    throw new Error(
      '[PIPELINE_BINDING_INVALID] acceptance requires an authenticated human final decision'
    );
  }
  if (
    approval.accountability?.finalDecision !== 'human_only' ||
    approval.accountability.payloadHash !== expectedPayloadHash ||
    approval.accountability.effectBinding !== PIPELINE_BINDING_EFFECT ||
    approval.correlationId !== `pipeline-binding:${expectedPayloadHash}`
  ) {
    throw new Error('[PIPELINE_BINDING_INVALID] approval is not bound to the exact effect');
  }
  return approval;
}

function scopeMatches(
  binding: AcceptedPipelineBindingScope,
  runtime: Pick<ScopeContext, 'tier' | 'tenant_slug' | 'organization_id' | 'project_id'>
): boolean {
  return (
    binding.tier === runtime.tier &&
    binding.tenant_slug === runtime.tenant_slug &&
    binding.organization_id === runtime.organization_id &&
    binding.project_id === runtime.project_id
  );
}

function loadCatalogForScope(
  scope: AcceptedPipelineBindingScope
): AcceptedPipelineBindingCatalogFile {
  const publicCatalog = catalogForPath(PUBLIC_CATALOG_PATH).load();
  validateAcceptedBindingCatalogScope(publicCatalog, { tier: 'public' });
  if (scope.tier === 'public') return publicCatalog;
  const overlay = catalogForPath(acceptedPipelineBindingCatalogPath(scope)).load();
  validateAcceptedBindingCatalogScope(overlay, scope);
  return { version: 1, bindings: [...publicCatalog.bindings, ...overlay.bindings] };
}

export function loadAcceptedPipelineBindingCatalog(
  scope: AcceptedPipelineBindingScope = { tier: 'public' }
): AcceptedPipelineBindingCatalogFile {
  return loadCatalogForScope(normalizedScope(scope));
}

export interface ResolveBindingInput {
  packet: Pick<
    IntentResolutionPacket,
    'selected_intent_id' | 'selected_confidence' | 'selected_resolution' | 'candidates'
  >;
  scope: Pick<ScopeContext, 'tier' | 'tenant_slug' | 'organization_id' | 'project_id'>;
  minimum_confidence?: number;
  pipeline_sha256?: string;
  governance?: {
    execution_shape?: string;
    requires_approval?: boolean;
    active_mission?: boolean;
    viewer_scope_authorized?: boolean;
  };
}

export function acceptedBindingGovernanceAllowsBypass(
  governance: ResolveBindingInput['governance']
): boolean {
  return !(
    governance?.execution_shape === 'mission' ||
    governance?.requires_approval ||
    governance?.active_mission ||
    governance?.viewer_scope_authorized === false
  );
}

export function resolveAcceptedPipelineBinding(
  input: ResolveBindingInput
): AcceptedPipelineBinding | null {
  const scope = normalizedScope(input.scope as AcceptedPipelineBindingScope);
  const catalog = loadCatalogForScope(scope);
  const candidates = resolveAcceptedPipelineBindingFromCatalog(catalog, input);
  if (!candidates) return null;
  return acceptedBindingMatchesPipelineHash(
    candidates,
    hashAcceptedPipeline(candidates.pipeline_ref)
  )
    ? candidates
    : null;
}

export function acceptedBindingMatchesPipelineHash(
  binding: AcceptedPipelineBinding,
  currentPipelineSha256: string
): boolean {
  return binding.successful_run_evidence.pipeline_sha256 === currentPipelineSha256;
}

export function resolveAcceptedPipelineBindingFromCatalog(
  bindingCatalog: AcceptedPipelineBindingCatalogFile,
  input: ResolveBindingInput
): AcceptedPipelineBinding | null {
  const intentId = input.packet.selected_intent_id;
  const confidence = input.packet.selected_confidence || 0;
  if (
    !intentId ||
    confidence < (input.minimum_confidence ?? 0.9) ||
    input.packet.selected_resolution?.shape !== 'pipeline'
  ) {
    return null;
  }
  if (!acceptedBindingGovernanceAllowsBypass(input.governance)) return null;
  const intent = requirePipelineIntent(
    intentId,
    normalizedScope(input.scope as AcceptedPipelineBindingScope)
  );
  // No accepted bypass for consequential intents without a separate,
  // per-execution grant. That grant is intentionally not implied by catalog acceptance.
  if (intent.risk_profile !== 'low') return null;
  const runnerUp = input.packet.candidates.find((candidate) => candidate.intent_id !== intentId);
  if (runnerUp && confidence - runnerUp.confidence < 0.1) return null;
  const matches = bindingCatalog.bindings.filter(
    (binding) =>
      binding.status === 'active' &&
      binding.intent_ids.includes(intentId) &&
      scopeMatches(binding.scope, input.scope) &&
      (!input.pipeline_sha256 ||
        binding.successful_run_evidence.pipeline_sha256 === input.pipeline_sha256)
  );
  return matches.length === 1 ? matches[0] : null;
}

export function acceptPromotedPipelineBinding(
  input: AcceptPromotedPipelineBindingInput
): AcceptedPipelineBinding {
  const effect = buildPipelineBindingEffect(input);
  const payloadHash = computeApprovalPayloadHash({ ...effect });
  const storageChannel =
    input.approval_storage_channel?.trim() || PIPELINE_BINDING_APPROVAL_CHANNEL;
  const approval = validatePipelineBindingApproval(
    loadApprovalRequest(storageChannel, input.approval_request_id),
    payloadHash
  );
  const evidence = requireSuccessfulRun(
    effect.pipeline_ref,
    effect.successful_run_id,
    effect.pipeline_sha256
  );
  const targetPath = acceptedPipelineBindingCatalogPath(effect.scope);
  const targetCatalog = catalogForPath(targetPath);
  const expectedGeneration = targetCatalog.generation();
  const current = targetCatalog.load();
  if (
    current.bindings.some(
      (binding) =>
        binding.status === 'active' &&
        binding.intent_ids.includes(effect.intent_id) &&
        scopeMatches(binding.scope, effect.scope as ScopeContext)
    )
  ) {
    throw new Error(
      `[PIPELINE_BINDING_INVALID] an active binding already exists for ${effect.intent_id} in this scope`
    );
  }
  const binding: AcceptedPipelineBinding = {
    binding_id: `accepted-${payloadHash.slice(0, 16)}`,
    pipeline_ref: effect.pipeline_ref,
    intent_ids: [effect.intent_id],
    scope: effect.scope,
    successful_run_evidence: evidence,
    approval_request_id: approval.id,
    accepted_at: nowIso(),
    status: 'active',
  };
  withExecutionContext('ecosystem_architect', () => {
    const directory = nodePath.dirname(pathResolver.rootResolve(targetPath));
    if (!safeExistsSync(directory)) safeMkdir(directory, { recursive: true });
    targetCatalog.publish(
      { ...current, bindings: [...current.bindings, binding] },
      expectedGeneration
    );
  });
  recordApprovalApplyResult('mission_controller', {
    channel: approval.channel,
    storageChannel,
    requestId: approval.id,
    applyResult: {
      appliedAt: nowIso(),
      appliedBy: 'pipeline-binding-acceptance',
      result: 'success',
      auditRef: targetPath,
    },
  });
  return binding;
}

export function resetAcceptedPipelineBindingCatalog(): void {
  for (const catalog of catalogCache.values()) catalog.reset();
  catalogCache.clear();
}
