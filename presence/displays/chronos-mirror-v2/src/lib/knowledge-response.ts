import { isRecord } from '@agent/core/foundation/primitives';

export type ClientKnowledgeCandidate = {
  candidate_id: string;
  status: 'queued' | 'approved' | 'rejected' | 'promoted';
  proposed_memory_kind: string;
  summary: string;
  evidence_refs: string[];
  sensitivity_tier: 'public' | 'confidential' | 'personal';
  source_ref: string;
  tenantSlug?: string;
  promoted_ref?: string;
  ratification_required: boolean;
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

function parseCandidate(value: unknown): ClientKnowledgeCandidate | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !nonEmptyString(value.candidate_id) ||
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
  ) {
    return undefined;
  }
  return {
    candidate_id: value.candidate_id,
    status: value.status,
    proposed_memory_kind: value.proposed_memory_kind,
    summary: value.summary,
    evidence_refs: value.evidence_refs,
    sensitivity_tier: value.sensitivity_tier,
    source_ref: value.source_ref,
    ...(value.tenantSlug !== undefined ? { tenantSlug: value.tenantSlug } : {}),
    ...(value.promoted_ref !== undefined ? { promoted_ref: value.promoted_ref } : {}),
    ratification_required: value.ratification_required,
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
  ) {
    return undefined;
  }
  const candidates = value.candidates.map(parseCandidate);
  return candidates.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    ? {
        ok: true,
        candidates,
        tenantSlugs: value.tenantSlugs,
        accessRole: value.accessRole,
      }
    : undefined;
}
