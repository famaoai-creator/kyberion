import { isRecord } from '@agent/core/foundation/primitives';
import type { MemoryScopeEnvelope } from '@agent/core/knowledge/memory-scope';
import type { ScopedLearningPublicationIdentity } from '@agent/core/knowledge/scoped-learning-contract';

export type ClientKnowledgeCuration = {
  title: string;
  summary: string;
  content: string;
  evidence_refs: string[];
};
export type ClientLearningState =
  | 'unsupported'
  | 'draft'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'revoked'
  | 'published'
  | 'error';
export type ClientKnowledgeLearning = {
  state: ClientLearningState;
  payloadDigest?: string;
  approvalRef?: string;
  publication?: ScopedLearningPublicationIdentity;
  reason?: string;
};
export type ClientKnowledgeCandidate = {
  candidate_id: string;
  candidateKey: string;
  status: 'queued' | 'approved' | 'rejected' | 'promoted';
  proposed_memory_kind: string;
  summary: string;
  evidence_refs: string[];
  sensitivity_tier: 'public' | 'confidential' | 'personal';
  source_ref: string;
  tenantSlug?: string;
  promoted_ref?: string;
  ratification_required: boolean;
  scope?: MemoryScopeEnvelope;
  curation?: ClientKnowledgeCuration;
  learning?: ClientKnowledgeLearning;
};
export type KnowledgeResponse = {
  ok: true;
  candidates: ClientKnowledgeCandidate[];
  tenantSlugs: string[] | 'all';
  accessRole: 'readonly' | 'localadmin';
};
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const STATUSES = new Set(['queued', 'approved', 'rejected', 'promoted']);
const TIERS = new Set(['public', 'confidential', 'personal']);
const LEARNING_STATES = new Set([
  'unsupported',
  'draft',
  'pending',
  'approved',
  'rejected',
  'expired',
  'revoked',
  'published',
  'error',
]);
const DIGEST = /^[a-f0-9]{64}$/;
const APPROVAL_REF = /^terminal:[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}
function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
/** Shape validation only. The server, not this projection, authorizes scope. */
function parseScope(value: unknown): MemoryScopeEnvelope | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    typeof value.tier !== 'string' ||
    !TIERS.has(value.tier)
  )
    return undefined;
  const strings = [
    'tenant_slug',
    'organization_id',
    'project_id',
    'mission_id',
    'task_id',
    'owner_nhi',
    'retention_policy',
    'viewer_principal',
    'nhi_id',
    'session_id',
    'work_shape',
    'customer_stance',
  ];
  if (
    Object.keys(value).some(
      (key) =>
        ![
          ...strings,
          'tier',
          'allowed_audience',
          'provenance_refs',
          'redacted',
          'promotion_policy',
        ].includes(key)
    )
  )
    return undefined;
  if (strings.some((key) => value[key] !== undefined && !nonEmptyString(value[key])))
    return undefined;
  if (value.allowed_audience !== undefined && !stringArray(value.allowed_audience))
    return undefined;
  if (value.provenance_refs !== undefined && !stringArray(value.provenance_refs)) return undefined;
  if (value.redacted !== undefined && typeof value.redacted !== 'boolean') return undefined;
  if (
    value.promotion_policy !== undefined &&
    !['same_scope', 'brokered', 'human_review'].includes(String(value.promotion_policy))
  )
    return undefined;
  return { ...value } as unknown as MemoryScopeEnvelope;
}
function scopeEqual(left: MemoryScopeEnvelope, right: MemoryScopeEnvelope | undefined): boolean {
  const ordered = (scope: MemoryScopeEnvelope | undefined) =>
    scope
      ? JSON.stringify(
          Object.entries(scope)
            .filter(([, value]) => value !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
        )
      : '';
  return ordered(left) === ordered(right);
}
function parseCuration(value: unknown): ClientKnowledgeCuration | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.title) ||
    !nonEmptyString(value.summary) ||
    !nonEmptyString(value.content) ||
    !stringArray(value.evidence_refs) ||
    !value.evidence_refs.length ||
    value.evidence_refs.some((ref) => !ref.trim())
  )
    return undefined;
  return {
    title: value.title,
    summary: value.summary,
    content: value.content,
    evidence_refs: value.evidence_refs,
  };
}
function parsePublication(value: unknown): ScopedLearningPublicationIdentity | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !nonEmptyString(value.candidate_id) ||
    !nonEmptyString(value.record_path) ||
    !nonEmptyString(value.markdown_path)
  )
    return undefined;
  const scope = parseScope(value.scope);
  if (
    !scope ||
    ['approved_payload_digest', 'record_sha256', 'markdown_sha256'].some(
      (key) => typeof value[key] !== 'string' || !DIGEST.test(value[key] as string)
    )
  )
    return undefined;
  if (
    value.record_path !== value.markdown_path.replace(/\.md$/, '.json') ||
    !value.markdown_path.endsWith('.md')
  )
    return undefined;
  return {
    version: 1,
    candidate_id: value.candidate_id,
    scope,
    approved_payload_digest: value.approved_payload_digest as string,
    record_path: value.record_path,
    markdown_path: value.markdown_path,
    record_sha256: value.record_sha256 as string,
    markdown_sha256: value.markdown_sha256 as string,
  };
}
function parseLearning(value: unknown): ClientKnowledgeLearning | undefined {
  if (
    !isRecord(value) ||
    typeof value.state !== 'string' ||
    !LEARNING_STATES.has(value.state) ||
    !optionalString(value.reason)
  )
    return undefined;
  if (
    value.payloadDigest !== undefined &&
    (typeof value.payloadDigest !== 'string' || !DIGEST.test(value.payloadDigest))
  )
    return undefined;
  if (
    value.approvalRef !== undefined &&
    (typeof value.approvalRef !== 'string' || !APPROVAL_REF.test(value.approvalRef))
  )
    return undefined;
  const publication =
    value.publication === undefined ? undefined : parsePublication(value.publication);
  if (value.publication !== undefined && !publication) return undefined;
  if (
    value.state === 'published' &&
    (!publication ||
      !value.approvalRef ||
      publication.approved_payload_digest !== value.payloadDigest)
  )
    return undefined;
  if (publication && value.state !== 'published') return undefined;
  if (['draft', 'pending', 'approved'].includes(value.state) && !value.payloadDigest)
    return undefined;
  if (['pending', 'approved'].includes(value.state) && !value.approvalRef) return undefined;
  return {
    state: value.state as ClientLearningState,
    ...(value.payloadDigest !== undefined ? { payloadDigest: value.payloadDigest as string } : {}),
    ...(value.approvalRef !== undefined ? { approvalRef: value.approvalRef as string } : {}),
    ...(publication ? { publication } : {}),
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
  };
}
export function parseKnowledgeCandidate(value: unknown): ClientKnowledgeCandidate | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    !nonEmptyString(value.candidate_id) ||
    !nonEmptyString(value.candidateKey) ||
    typeof value.status !== 'string' ||
    !STATUSES.has(value.status) ||
    !nonEmptyString(value.proposed_memory_kind) ||
    !nonEmptyString(value.summary) ||
    !stringArray(value.evidence_refs) ||
    typeof value.sensitivity_tier !== 'string' ||
    !TIERS.has(value.sensitivity_tier) ||
    !nonEmptyString(value.source_ref) ||
    !optionalString(value.tenantSlug) ||
    !optionalString(value.promoted_ref) ||
    typeof value.ratification_required !== 'boolean'
  )
    return undefined;
  const scope = value.scope === undefined ? undefined : parseScope(value.scope);
  const curation = value.curation === undefined ? undefined : parseCuration(value.curation);
  const learning = value.learning === undefined ? undefined : parseLearning(value.learning);
  if (
    (value.scope !== undefined && !scope) ||
    (value.curation !== undefined && !curation) ||
    (value.learning !== undefined && !learning)
  )
    return undefined;
  if (
    learning &&
    ['pending', 'approved', 'published'].includes(learning.state) &&
    (!scope || !curation)
  )
    return undefined;
  if (
    learning?.publication &&
    (learning.publication.candidate_id !== value.candidate_id ||
      !scopeEqual(learning.publication.scope, scope) ||
      learning.publication.markdown_path !== value.promoted_ref ||
      value.status !== 'promoted')
  )
    return undefined;
  return {
    candidate_id: value.candidate_id,
    candidateKey: value.candidateKey,
    status: value.status as ClientKnowledgeCandidate['status'],
    proposed_memory_kind: value.proposed_memory_kind,
    summary: value.summary,
    evidence_refs: value.evidence_refs,
    sensitivity_tier: value.sensitivity_tier as ClientKnowledgeCandidate['sensitivity_tier'],
    source_ref: value.source_ref,
    ...(value.tenantSlug !== undefined ? { tenantSlug: value.tenantSlug } : {}),
    ...(value.promoted_ref !== undefined ? { promoted_ref: value.promoted_ref } : {}),
    ratification_required: value.ratification_required,
    ...(scope ? { scope } : {}),
    ...(curation ? { curation } : {}),
    ...(learning ? { learning } : {}),
  };
}
export function parseKnowledgeResponse(value: unknown): KnowledgeResponse | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    value.ok !== true ||
    !Array.isArray(value.candidates) ||
    (!stringArray(value.tenantSlugs) && value.tenantSlugs !== 'all') ||
    (value.accessRole !== 'readonly' && value.accessRole !== 'localadmin')
  )
    return undefined;
  const candidates = value.candidates.map(parseKnowledgeCandidate);
  if (!candidates.every((entry): entry is ClientKnowledgeCandidate => entry !== undefined))
    return undefined;
  if (new Set(candidates.map((entry) => entry.candidateKey)).size !== candidates.length)
    return undefined;
  return { ok: true, candidates, tenantSlugs: value.tenantSlugs, accessRole: value.accessRole };
}
