/**
 * D8 / MEMORY_LOOP_CLOSURE M2: facade-decided proposals on the one queue.
 *
 * Background-review patch proposals (`pnpm background-review`),
 * execution-feedback improvement proposals (`pnpm kyberion improvements`),
 * learning-intake reuse plans (`pnpm kyberion learning prepare`), service
 * procedure candidates and mission-seed reuse proposals (both decided in
 * Concierge) are `MemoryCandidate` rows with an `origin` naming the facade and
 * the command that decides them. This module is the shared projection between such
 * a row and the proposal view the facade reasons about (status, metadata,
 * target), so approve / apply / archive act on queue rows and
 * `DistillCandidateRecord` stays a promotion receipt.
 *
 * Scope is required at capture and never inferred: the producer passes the
 * mission's or session's real scope, and the queue rejects a non-public row
 * without one (`MEMORY_SCOPE_REQUIRED`). Rows with `origin` are never promoted
 * by the generic promotion workflow (`MEMORY_PROMOTION_OWNED`).
 */

import { randomUUID } from 'node:crypto';
import { withLockSync } from '../foundation/lock-utils.js';
import { nowIso } from '../foundation/time.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  listMemoryPromotionCandidates,
  memoryPromotionScopeKey,
  updateMemoryPromotionCandidateStatus,
  type MemoryCandidate,
  type MemoryCandidateKind,
  type MemoryCandidateOriginKind,
  type MemoryCandidateStatus,
  type MemoryCandidateTier,
  type MemoryLearningKind,
} from './memory-promotion-queue.js';
import { assertMemoryScope, type MemoryScopeEnvelope } from './memory-scope.js';

export type FacadeProposalStatus = 'proposed' | 'promoted' | 'archived';

/** The proposal view a facade reads and decides (the legacy record's shape). */
export interface FacadeProposalRecord {
  candidate_id: string;
  source_type: 'task_session' | 'mission' | 'artifact';
  tier: MemoryCandidateTier;
  mission_id?: string;
  task_session_id?: string;
  title: string;
  summary: string;
  status: FacadeProposalStatus;
  target_kind: 'pattern' | 'sop_candidate' | 'knowledge_hint' | 'report_template' | 'procedure';
  locale?: string;
  promoted_ref?: string;
  evidence_refs: string[];
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
  /** Canonical capture scope (always present on rows captured since D8). */
  scope?: MemoryScopeEnvelope;
  /** Set when the row was imported from the read-only legacy record store. */
  migrated_from?: string;
  project_id?: string;
  track_id?: string;
  track_name?: string;
  specialist_id?: string;
  work_loop?: Record<string, unknown>;
  /** Which facade owns the row (`origin.record_kind`); set on projection. */
  record_kind?: FacadeProposalKind;
  /** The command or surface that decides the row (`origin.decided_via`). */
  decided_via?: string;
}

/** Facade kinds whose rows project into {@link FacadeProposalRecord}. */
export const FACADE_PROPOSAL_KINDS = [
  'background_review',
  'execution_feedback',
  'learning_intake',
  'service_procedure',
  'mission_seed',
] as const satisfies readonly MemoryCandidateOriginKind[];
export type FacadeProposalKind = (typeof FACADE_PROPOSAL_KINDS)[number];

/** `origin.decided_via` of rows decided on the Concierge reuse-proposal panel. */
export const CONCIERGE_DECIDED_VIA = 'concierge';

export interface FacadeProposalSpec {
  recordKind: FacadeProposalKind;
  learningKind: MemoryLearningKind;
  /** The command that decides the row (`origin.decided_via`). */
  decidedVia: string;
  idPrefix: string;
}

/** Marker for rows imported from the legacy DistillCandidateRecord store. */
export const LEGACY_DISTILL_CANDIDATE_STORE = 'distill-candidate-registry';

const TO_QUEUE_STATUS: Record<FacadeProposalStatus, MemoryCandidateStatus> = {
  proposed: 'queued',
  promoted: 'promoted',
  archived: 'rejected',
};
const FROM_QUEUE_STATUS: Record<MemoryCandidateStatus, FacadeProposalStatus> = {
  queued: 'proposed',
  // Facade rows never use `approved`; read it as still awaiting the facade.
  approved: 'proposed',
  rejected: 'archived',
  promoted: 'promoted',
};

function storageScope(scope: MemoryScopeEnvelope): MemoryScopeEnvelope {
  const canonical = assertMemoryScope(scope, scope.tier);
  if (
    Object.entries(scope).some(
      ([field, value]) => value !== undefined && !Object.hasOwn(canonical, field)
    )
  )
    throw new Error('[MEMORY_SCOPE_UNSUPPORTED] Unknown scope fields cannot be dropped');
  return canonical;
}

export interface CaptureFacadeProposalInput extends Omit<
  FacadeProposalRecord,
  | 'candidate_id'
  | 'created_at'
  | 'updated_at'
  | 'tier'
  | 'scope'
  | 'status'
  | 'migrated_from'
  | 'record_kind'
  | 'decided_via'
> {
  candidate_id?: string;
  created_at?: string;
  status?: FacadeProposalStatus;
  /** Required: the mission's / session's real scope, written at capture. */
  scope: MemoryScopeEnvelope;
  /** The knowledge format the row stands for on the queue. */
  proposedMemoryKind: MemoryCandidateKind;
  migratedFrom?: string;
}

/** Build (without persisting) the queue row of one proposal; scope required. */
export function buildFacadeProposalRow(
  spec: FacadeProposalSpec,
  input: CaptureFacadeProposalInput
): MemoryCandidate {
  if (!input.scope)
    throw new Error(
      `[MEMORY_SCOPE_REQUIRED] ${spec.recordKind} proposal has no scope — pass the mission or session scope at capture`
    );
  const scope = storageScope(input.scope);
  const tier = input.scope.tier;
  const createdAt = input.created_at || nowIso();
  const candidateId =
    input.candidate_id ||
    `${spec.idPrefix}-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const status = input.status || 'proposed';
  const title = String(input.title || '').trim() || candidateId;
  const base = createMemoryPromotionCandidate({
    candidateId,
    kind: spec.learningKind,
    sourceType: input.source_type,
    sourceRef: `${spec.recordKind}:${candidateId}`,
    proposedMemoryKind: input.proposedMemoryKind,
    summary: String(input.summary || '').trim() || title,
    evidenceRefs: input.evidence_refs,
    sensitivityTier: tier,
    ratificationRequired: true,
    queuedAt: createdAt,
    scope,
  });
  const row: MemoryCandidate = {
    ...base,
    status: TO_QUEUE_STATUS[status],
    ...(input.promoted_ref ? { promoted_ref: input.promoted_ref } : {}),
    origin: {
      record_kind: spec.recordKind,
      record_id: candidateId,
      title: title.slice(0, 120),
      decided_via: spec.decidedVia,
      attributes: {
        source_type: input.source_type,
        ...(input.mission_id ? { mission_id: input.mission_id } : {}),
        ...(input.task_session_id ? { task_session_id: input.task_session_id } : {}),
        ...(input.project_id ? { project_id: input.project_id } : {}),
        ...(input.track_id ? { track_id: input.track_id } : {}),
        ...(input.track_name ? { track_name: input.track_name } : {}),
        ...(input.specialist_id ? { specialist_id: input.specialist_id } : {}),
        ...(input.work_loop ? { work_loop: input.work_loop } : {}),
        title,
        summary: input.summary,
        target_kind: input.target_kind,
        ...(input.locale ? { locale: input.locale } : {}),
        evidence_refs: input.evidence_refs,
        metadata: input.metadata || {},
        created_at: createdAt,
        updated_at: nowIso(),
      },
      ...(input.migratedFrom ? { migrated_from: input.migratedFrom } : {}),
    },
  };
  return row;
}

/** Capture one proposal as a queue row with its scope; returns the view. */
export function captureFacadeProposal(
  spec: FacadeProposalSpec,
  input: CaptureFacadeProposalInput
): FacadeProposalRecord {
  const row = buildFacadeProposalRow(spec, input);
  enqueueMemoryPromotionCandidate(row);
  const candidateId = row.candidate_id;
  const stored = loadFacadeProposal(spec, candidateId, row.scope);
  if (!stored)
    throw new Error(`[FACADE_PROPOSAL_PERSISTENCE] ${candidateId} was not found after capture`);
  return stored;
}

function attr<T>(attributes: Record<string, unknown>, key: string): T | undefined {
  return attributes[key] as T | undefined;
}

/** Project a facade-owned queue row back into its proposal view. */
export function projectFacadeProposal(
  spec: Pick<FacadeProposalSpec, 'recordKind'>,
  row: MemoryCandidate
): FacadeProposalRecord | null {
  if (row.origin?.record_kind !== spec.recordKind) return null;
  const attributes = (row.origin.attributes || {}) as Record<string, unknown>;
  const missionId = attr<string>(attributes, 'mission_id');
  const taskSessionId = attr<string>(attributes, 'task_session_id');
  const locale = attr<string>(attributes, 'locale');
  const optional = Object.fromEntries(
    (['project_id', 'track_id', 'track_name', 'specialist_id'] as const).flatMap((key) => {
      const value = attr<string>(attributes, key);
      return typeof value === 'string' && value ? [[key, value]] : [];
    })
  ) as Pick<FacadeProposalRecord, 'project_id' | 'track_id' | 'track_name' | 'specialist_id'>;
  const workLoop = attr<Record<string, unknown>>(attributes, 'work_loop');
  return {
    candidate_id: row.candidate_id,
    source_type:
      attr<FacadeProposalRecord['source_type']>(attributes, 'source_type') ||
      (row.source_type === 'mission' || row.source_type === 'artifact'
        ? row.source_type
        : 'task_session'),
    tier: row.sensitivity_tier,
    ...(missionId ? { mission_id: missionId } : {}),
    ...(taskSessionId ? { task_session_id: taskSessionId } : {}),
    ...optional,
    ...(workLoop && typeof workLoop === 'object' ? { work_loop: structuredClone(workLoop) } : {}),
    title: attr<string>(attributes, 'title') || row.origin.title || row.candidate_id,
    summary: attr<string>(attributes, 'summary') ?? row.summary,
    status: FROM_QUEUE_STATUS[row.status],
    target_kind: attr<FacadeProposalRecord['target_kind']>(attributes, 'target_kind') || 'pattern',
    ...(locale ? { locale } : {}),
    ...(row.promoted_ref ? { promoted_ref: row.promoted_ref } : {}),
    evidence_refs: attr<string[]>(attributes, 'evidence_refs') || row.evidence_refs,
    created_at: attr<string>(attributes, 'created_at') || row.queued_at,
    updated_at: attr<string>(attributes, 'updated_at') || row.last_seen || row.queued_at,
    metadata: structuredClone(attr<Record<string, unknown>>(attributes, 'metadata') || {}),
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.origin.migrated_from ? { migrated_from: row.origin.migrated_from } : {}),
    record_kind: row.origin.record_kind as FacadeProposalKind,
    ...(row.origin.decided_via ? { decided_via: row.origin.decided_via } : {}),
  };
}

/** Project any facade-owned row (every {@link FACADE_PROPOSAL_KINDS} kind); null otherwise. */
export function projectAnyFacadeProposal(row: MemoryCandidate): FacadeProposalRecord | null {
  const kind = row.origin?.record_kind;
  if (!kind || !(FACADE_PROPOSAL_KINDS as readonly string[]).includes(kind)) return null;
  return projectFacadeProposal({ recordKind: kind as FacadeProposalKind }, row);
}

/**
 * Proposal rows of one facade. With `scope`, only that exact scope (personal
 * owner partitions are only reachable this way); without it, the shared and
 * tenant queues.
 */
export function listFacadeProposals(
  spec: Pick<FacadeProposalSpec, 'recordKind'>,
  scope?: MemoryScopeEnvelope
): FacadeProposalRecord[] {
  const selected = scope ? storageScope(scope) : undefined;
  const key = selected ? memoryPromotionScopeKey(selected) : undefined;
  return listMemoryPromotionCandidates(selected)
    .filter((row) => key === undefined || memoryPromotionScopeKey(row.scope) === key)
    .flatMap((row) => {
      const view = projectFacadeProposal(spec, row);
      return view ? [view] : [];
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function loadFacadeProposal(
  spec: Pick<FacadeProposalSpec, 'recordKind'>,
  candidateId: string,
  scope?: MemoryScopeEnvelope
): FacadeProposalRecord | null {
  const id = String(candidateId || '').trim();
  if (!id) return null;
  const matches = listFacadeProposals(spec, scope).filter((row) => row.candidate_id === id);
  if (matches.length > 1)
    throw new Error(
      `[MEMORY_PROMOTION_AMBIGUOUS] ${spec.recordKind} proposal '${id}' exists in multiple scopes; provide scope`
    );
  return matches[0] || null;
}

export interface FacadeProposalPatch {
  status?: FacadeProposalStatus;
  promoted_ref?: string;
  title?: string;
  summary?: string;
  evidence_refs?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Decide or annotate one proposal row. The status change is a
 * compare-and-set against the status the caller read.
 */
export function updateFacadeProposal(
  spec: Pick<FacadeProposalSpec, 'recordKind'>,
  candidateId: string,
  patch: FacadeProposalPatch,
  options: { scope?: MemoryScopeEnvelope; note?: string } = {}
): FacadeProposalRecord | null {
  const current = loadFacadeProposal(spec, candidateId, options.scope);
  if (!current) return null;
  const status = patch.status || current.status;
  const updated = updateMemoryPromotionCandidateStatus({
    candidateId: current.candidate_id,
    ...(current.scope ? { scope: current.scope } : {}),
    status: TO_QUEUE_STATUS[status],
    expectedStatus: TO_QUEUE_STATUS[current.status],
    ...(patch.promoted_ref ? { promotedRef: patch.promoted_ref } : {}),
    ...(options.note ? { ratificationNote: options.note } : {}),
    originAttributes: {
      updated_at: nowIso(),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.evidence_refs !== undefined ? { evidence_refs: patch.evidence_refs } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
    },
  });
  return updated ? projectFacadeProposal(spec, updated) : null;
}

/** Serialize a proposal's read/modify/write with references held in other stores. */
export function withFacadeProposalLock<T>(
  spec: Pick<FacadeProposalSpec, 'recordKind'>,
  candidateId: string,
  action: () => T
): T {
  return withLockSync(`facade-proposal:${spec.recordKind}:${candidateId}`, action);
}

/** Conditional read/modify/write under the proposal lock (callback must not re-lock it). */
export function mutateFacadeProposal(
  spec: Pick<FacadeProposalSpec, 'recordKind'>,
  candidateId: string,
  mutate: (current: FacadeProposalRecord) => FacadeProposalPatch | null,
  scope?: MemoryScopeEnvelope
): FacadeProposalRecord | null {
  return withFacadeProposalLock(spec, candidateId, () => {
    const current = loadFacadeProposal(spec, candidateId, scope);
    if (!current) return null;
    const patch = mutate(structuredClone(current));
    if (!patch) return current;
    return updateFacadeProposal(spec, candidateId, patch, { scope });
  });
}
