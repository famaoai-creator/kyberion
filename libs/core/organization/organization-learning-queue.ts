/**
 * D8 / MEMORY_LOOP_CLOSURE M2: organization learning candidates decide on the
 * single MemoryCandidate queue.
 *
 * `pnpm organization learning enqueue|transition` stay the facade, but the
 * record they create and decide is a queue row (`kind: organization_learning`,
 * `origin.record_kind: organization_learning`). The per-organization
 * `learning/<id>/candidate.json` store is read-only legacy: it is
 * still listed for history, and `migrateLegacyOrganizationLearningCandidates`
 * imports its pending items (proposed / approved) for one release with their
 * real scope. An item whose scope cannot be determined from the record itself
 * (personal tier has no owner, confidential has no tenant) is reported, never
 * guessed.
 */
import { nowIso } from '../foundation/time.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  listMemoryPromotionCandidates,
  memoryPromotionScopeKey,
  updateMemoryPromotionCandidateStatus,
  type MemoryCandidate,
  type MemoryCandidateKind,
  type MemoryCandidateSourceType,
  type MemoryCandidateStatus,
} from '../knowledge/memory-promotion-queue.js';
import type { MemoryScopeEnvelope } from '../knowledge/memory-scope.js';
import {
  listOrganizationRecordFiles,
  organizationQueryTenantSlug,
  readJsonRecord,
  validateOrganizationLearningCandidate,
} from './organization-operating-model-persistence.js';
import type {
  OrganizationLearningCandidate,
  OrganizationTier,
} from './organization-operating-model.js';

const LEARNING_FILE_NAME = 'candidate.json';
/** Marker for rows imported by the one-release migration. */
export const LEGACY_ORGANIZATION_LEARNING_STORE = 'organization-learning-store';

type LearningStatus = OrganizationLearningCandidate['status'];

const TO_QUEUE_STATUS: Record<LearningStatus, MemoryCandidateStatus> = {
  proposed: 'queued',
  approved: 'approved',
  rejected: 'rejected',
  promoted: 'promoted',
};
const FROM_QUEUE_STATUS: Record<MemoryCandidateStatus, LearningStatus> = {
  queued: 'proposed',
  approved: 'approved',
  rejected: 'rejected',
  promoted: 'promoted',
};
const TARGET_TO_MEMORY_KIND: Record<
  OrganizationLearningCandidate['target_kind'],
  MemoryCandidateKind
> = {
  pattern: 'heuristic',
  sop_candidate: 'sop',
  knowledge_hint: 'clarification_prompt',
  report_template: 'template',
};

export interface OrganizationLearningQuery {
  organizationId?: string;
  tier?: OrganizationTier;
  tenantSlug?: string;
  rootDir?: string;
  status?: LearningStatus;
}

/** Queue identity of an organization learning (learning ids are unique per organization). */
export function organizationLearningCandidateId(
  organizationId: string,
  learningId: string
): string {
  return `ORGL-${organizationId}-${learningId}`;
}

/**
 * The capture scope of an organization learning, read from the record only.
 * Throws `[MEMORY_SCOPE_REQUIRED]` when the record does not determine it.
 */
export function organizationLearningScope(
  record: Pick<OrganizationLearningCandidate, 'organization_id' | 'tier' | 'tenant_slug'>,
  options: { ownerNhi?: string } = {}
): MemoryScopeEnvelope {
  const tenant = String(record.tenant_slug || '').trim();
  if (record.tier === 'confidential') {
    if (!tenant || tenant === 'shared')
      throw new Error(
        `[MEMORY_SCOPE_REQUIRED] confidential organization learning for '${record.organization_id}' has no tenant_slug | next: re-create it with --tenant-slug <tenant>`
      );
    return { tier: 'confidential', tenant_slug: tenant, organization_id: record.organization_id };
  }
  if (record.tier === 'personal') {
    const owner = String(options.ownerNhi || '').trim();
    if (!owner)
      throw new Error(
        `[MEMORY_SCOPE_REQUIRED] personal organization learning for '${record.organization_id}' has no owner_nhi | next: personal learnings need an explicit owner; the record does not name one`
      );
    return {
      tier: 'personal',
      owner_nhi: owner,
      organization_id: record.organization_id,
      ...(tenant && tenant !== 'shared' ? { tenant_slug: tenant } : {}),
    };
  }
  // Public: a tenant on a public scope would need a brokered promotion, so the
  // record's tenant label (if any) travels in origin.attributes instead.
  return { tier: 'public', organization_id: record.organization_id };
}

function sourceTypeFor(record: OrganizationLearningCandidate): MemoryCandidateSourceType {
  return record.source_type === 'incident_review' ? 'incident' : 'authored';
}

/** Build the queue row an organization learning stands for. */
export function toOrganizationLearningMemoryCandidate(
  record: OrganizationLearningCandidate,
  options: { ownerNhi?: string; migratedFrom?: string } = {}
): MemoryCandidate {
  const scope = organizationLearningScope(record, options);
  const candidate = createMemoryPromotionCandidate({
    candidateId: organizationLearningCandidateId(record.organization_id, record.learning_id),
    kind: 'organization_learning',
    sourceType: sourceTypeFor(record),
    sourceRef: `organization_learning:${record.organization_id}/${record.learning_id}`,
    proposedMemoryKind: TARGET_TO_MEMORY_KIND[record.target_kind],
    summary: record.summary,
    // The queue needs evidence; a learning without its own refs is evidenced by its source.
    evidenceRefs: record.evidence_refs.length ? record.evidence_refs : [record.source_ref],
    sensitivityTier: record.tier,
    queuedAt: record.created_at,
    scope,
  });
  return {
    ...candidate,
    status: TO_QUEUE_STATUS[record.status],
    last_seen: record.updated_at,
    ...(record.decision_note ? { ratification_note: record.decision_note } : {}),
    ...(record.promoted_ref ? { promoted_ref: record.promoted_ref } : {}),
    origin: {
      record_kind: 'organization_learning',
      record_id: record.learning_id,
      title: record.title,
      attributes: {
        version: record.version,
        source_type: record.source_type,
        source_ref: record.source_ref,
        target_kind: record.target_kind,
        evidence_refs: record.evidence_refs,
        ...(record.tenant_slug ? { tenant_slug: record.tenant_slug } : {}),
        ...(record.metadata ? { metadata: record.metadata } : {}),
      },
      ...(options.migratedFrom ? { migrated_from: options.migratedFrom } : {}),
    },
  };
}

/** Project a queue row back into the facade's view; null for any other row. */
export function fromOrganizationLearningMemoryCandidate(
  row: MemoryCandidate
): OrganizationLearningCandidate | null {
  if (row.origin?.record_kind !== 'organization_learning') return null;
  const attributes = (row.origin.attributes || {}) as Record<string, unknown>;
  const organizationId = String(row.scope?.organization_id || '');
  const tenant =
    row.scope?.tenant_slug ||
    (typeof attributes.tenant_slug === 'string' ? attributes.tenant_slug : undefined);
  const record: OrganizationLearningCandidate = {
    version: typeof attributes.version === 'string' ? attributes.version : '1.0.0',
    learning_id: row.origin.record_id,
    organization_id: organizationId,
    source_type: attributes.source_type as OrganizationLearningCandidate['source_type'],
    source_ref: String(attributes.source_ref || row.source_ref),
    title: row.origin.title || row.summary.slice(0, 80),
    summary: row.summary,
    evidence_refs: Array.isArray(attributes.evidence_refs)
      ? (attributes.evidence_refs as string[])
      : row.evidence_refs,
    target_kind: attributes.target_kind as OrganizationLearningCandidate['target_kind'],
    status: FROM_QUEUE_STATUS[row.status],
    tier: (row.scope?.tier || row.sensitivity_tier) as OrganizationTier,
    ...(tenant ? { tenant_slug: tenant } : {}),
    ...(row.ratification_note ? { decision_note: row.ratification_note } : {}),
    ...(row.promoted_ref ? { promoted_ref: row.promoted_ref } : {}),
    created_at: row.queued_at,
    updated_at: row.last_seen || row.queued_at,
    ...(attributes.metadata && typeof attributes.metadata === 'object'
      ? { metadata: attributes.metadata as Record<string, unknown> }
      : {}),
  };
  return validateOrganizationLearningCandidate(record) ? record : null;
}

function queueScopeForQuery(query: OrganizationLearningQuery): MemoryScopeEnvelope | undefined {
  const tenant = String(organizationQueryTenantSlug(query.tenantSlug) || '').trim();
  if (query.tier === 'confidential' && tenant && tenant !== 'shared')
    return { tier: 'confidential', tenant_slug: tenant };
  return undefined;
}

function matchesQuery(
  record: OrganizationLearningCandidate,
  query: OrganizationLearningQuery
): boolean {
  if (query.organizationId && record.organization_id !== query.organizationId) return false;
  if (query.tier && record.tier !== query.tier) return false;
  const tenant = String(organizationQueryTenantSlug(query.tenantSlug) || '').trim();
  const recordTenant = String(record.tenant_slug || '').trim() || 'shared';
  if (record.tier !== 'public' && recordTenant !== (tenant || 'shared')) return false;
  if (query.status && record.status !== query.status) return false;
  return true;
}

/** Organization learnings on the queue (the decision source of truth). */
export function listQueuedOrganizationLearningCandidates(
  query: OrganizationLearningQuery = {}
): OrganizationLearningCandidate[] {
  return listMemoryPromotionCandidates(queueScopeForQuery(query))
    .map(fromOrganizationLearningMemoryCandidate)
    .filter((record): record is OrganizationLearningCandidate => Boolean(record))
    .filter((record) => matchesQuery(record, query));
}

/** Read-only legacy store (per-organization learning/<id>/candidate.json files). */
export function listLegacyOrganizationLearningCandidates(
  query: OrganizationLearningQuery = {}
): OrganizationLearningCandidate[] {
  return listOrganizationRecordFiles('learning', LEARNING_FILE_NAME, query)
    .map((filePath) =>
      readJsonRecord<OrganizationLearningCandidate>(filePath, 'organization learning candidate')
    )
    .filter((record): record is OrganizationLearningCandidate =>
      Boolean(record && validateOrganizationLearningCandidate(record))
    )
    .filter((record) => !query.status || record.status === query.status);
}

const learningKey = (
  record: Pick<OrganizationLearningCandidate, 'organization_id' | 'learning_id'>
) => `${record.organization_id}/${record.learning_id}`;

/**
 * Queue rows plus legacy records the queue does not hold yet (history and
 * not-yet-migrated items). The queue row wins on a shared learning id.
 */
export function listOrganizationLearningCandidatesFromQueue(
  query: OrganizationLearningQuery = {}
): OrganizationLearningCandidate[] {
  const queued = listQueuedOrganizationLearningCandidates(query);
  const seen = new Set(queued.map(learningKey));
  const legacy = listLegacyOrganizationLearningCandidates(query).filter(
    (record) => !seen.has(learningKey(record))
  );
  return [...queued, ...legacy].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** Capture a new organization learning on the queue. */
export function enqueueOrganizationLearningOnQueue(
  record: OrganizationLearningCandidate,
  options: { ownerNhi?: string } = {}
): OrganizationLearningCandidate {
  const row = toOrganizationLearningMemoryCandidate(record, options);
  enqueueMemoryPromotionCandidate(row);
  return record;
}

/**
 * Persist a decided transition (see `transitionOrganizationLearningCandidate`)
 * on the queue row. Legacy-only records must be migrated first; the old
 * store is never written again.
 */
export function saveOrganizationLearningDecision(
  previous: OrganizationLearningCandidate,
  next: OrganizationLearningCandidate
): MemoryCandidate {
  const candidateId = organizationLearningCandidateId(next.organization_id, next.learning_id);
  const scope = queueRowScope(candidateId, next);
  if (!scope)
    throw new Error(
      `[ORGANIZATION_LEARNING_NOT_ON_QUEUE] learning '${next.learning_id}' is only in the read-only legacy store | next: pnpm organization learning migrate --organization-id ${next.organization_id} --apply, then retry the transition`
    );
  const updated = updateMemoryPromotionCandidateStatus({
    candidateId,
    scope,
    status: TO_QUEUE_STATUS[next.status],
    expectedStatus: TO_QUEUE_STATUS[previous.status],
    ...(next.decision_note ? { ratificationNote: next.decision_note } : {}),
    ...(next.promoted_ref ? { promotedRef: next.promoted_ref } : {}),
  });
  if (!updated)
    throw new Error(`[ORGANIZATION_LEARNING_NOT_ON_QUEUE] learning '${next.learning_id}' vanished`);
  return updated;
}

function queueRowScope(
  candidateId: string,
  record: OrganizationLearningCandidate
): MemoryScopeEnvelope | undefined {
  const row = listMemoryPromotionCandidates(
    queueScopeForQuery({ tier: record.tier, tenantSlug: record.tenant_slug })
  ).find(
    (entry) =>
      entry.candidate_id === candidateId && entry.origin?.record_kind === 'organization_learning'
  );
  return row?.scope;
}

export interface OrganizationLearningMigrationReport {
  mode: 'dry_run' | 'apply';
  imported: Array<{ organization_id: string; learning_id: string; status: LearningStatus }>;
  already_on_queue: string[];
  /** Pending items whose scope the record does not determine — reported, not guessed. */
  unresolved: Array<{ organization_id: string; learning_id: string; tier: string; reason: string }>;
  /** Decided (rejected / promoted) items stay read-only history in the legacy store. */
  left_as_history: string[];
}

/**
 * One-release migration: import pending legacy learnings onto the queue with
 * the scope their own record declares. Idempotent — an item already on the
 * queue (same candidate id and scope) is skipped.
 */
export function migrateLegacyOrganizationLearningCandidates(
  query: OrganizationLearningQuery & { apply?: boolean } = {}
): OrganizationLearningMigrationReport {
  const report: OrganizationLearningMigrationReport = {
    mode: query.apply ? 'apply' : 'dry_run',
    imported: [],
    already_on_queue: [],
    unresolved: [],
    left_as_history: [],
  };
  for (const record of listLegacyOrganizationLearningCandidates({ ...query, status: undefined })) {
    const key = learningKey(record);
    if (record.status === 'rejected' || record.status === 'promoted') {
      report.left_as_history.push(key);
      continue;
    }
    let row: MemoryCandidate;
    try {
      row = toOrganizationLearningMemoryCandidate(record, {
        migratedFrom: LEGACY_ORGANIZATION_LEARNING_STORE,
      });
    } catch (error) {
      report.unresolved.push({
        organization_id: record.organization_id,
        learning_id: record.learning_id,
        tier: record.tier,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const scopeKey = memoryPromotionScopeKey(row.scope);
    const exists = listMemoryPromotionCandidates(row.scope).some(
      (entry) =>
        entry.candidate_id === row.candidate_id && memoryPromotionScopeKey(entry.scope) === scopeKey
    );
    if (exists) {
      report.already_on_queue.push(key);
      continue;
    }
    if (query.apply)
      enqueueMemoryPromotionCandidate({ ...row, last_seen: row.last_seen || nowIso() });
    report.imported.push({
      organization_id: record.organization_id,
      learning_id: record.learning_id,
      status: record.status,
    });
  }
  return report;
}
