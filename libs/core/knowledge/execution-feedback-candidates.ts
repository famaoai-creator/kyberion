/**
 * Execution-feedback improvement proposals.
 *
 * D8 / MEMORY_LOOP_CLOSURE M2: a proposal is a MemoryCandidate queue row
 * (`kind: execution_feedback`, `origin.record_kind: execution_feedback`,
 * decided via `pnpm kyberion improvements`) captured with the feedback's real
 * scope. The legacy DistillCandidateRecord-shaped files (the unscoped global
 * distill-candidate store and the scoped `execution-feedback/.../candidates/`
 * directories) are read-only history; for one release
 * `migrateLegacyExecutionFeedbackCandidates` imports their pending items with
 * the scope the record declares, and reports unscoped ones (never guessed).
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { physicalScopedPath } from '../storage/physical-namespace.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReaddir } from '../secure-io.js';
import { assertMemoryScope, type MemoryScopeEnvelope } from './memory-scope.js';
import {
  loadDistillCandidateRecord,
  listDistillCandidateRecords,
  type DistillCandidateRecord,
} from './distill-candidate-registry.js';
import {
  captureFacadeProposal,
  LEGACY_DISTILL_CANDIDATE_STORE,
  listFacadeProposals,
  updateFacadeProposal,
  type FacadeProposalRecord,
  type FacadeProposalSpec,
} from './facade-proposal-rows.js';

export const EXECUTION_FEEDBACK_PROPOSAL: FacadeProposalSpec = {
  recordKind: 'execution_feedback',
  learningKind: 'execution_feedback',
  decidedVia: 'pnpm kyberion improvements',
  idPrefix: 'EFP',
};

/** A queue-backed proposal, or a read-only legacy record (`legacy_read_only`). */
export interface ExecutionFeedbackCandidate extends FacadeProposalRecord {
  legacy_read_only?: true;
}

export function executionFeedbackScopeKey(scope?: MemoryScopeEnvelope): string {
  if (!scope) return 'unscoped-legacy';
  const canonical = assertMemoryScope(scope);
  if (
    Object.entries(scope).some(
      ([key, value]) => value !== undefined && !Object.hasOwn(canonical, key)
    )
  ) {
    throw new Error(
      '[FEEDBACK_SCOPE_UNSUPPORTED] Unknown or non-canonical scope fields cannot be dropped'
    );
  }
  return JSON.stringify(canonical);
}
export function executionFeedbackScopeRoot(scope: MemoryScopeEnvelope): string {
  const scopeKey = executionFeedbackScopeKey(scope);
  const canonical = assertMemoryScope(scope);
  if (!canonical.tenant_slug)
    throw new Error(
      '[FEEDBACK_SCOPE_UNSUPPORTED] Scoped feedback requires an explicit tenant namespace; owner-only scope is not supported'
    );
  const key = createHash('sha256').update(scopeKey).digest('hex');
  return pathResolver.rootResolve(
    physicalScopedPath(
      'active/shared/runtime',
      canonical,
      'execution-feedback',
      canonical.tier,
      key
    )
  );
}
function assertCandidateId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(id))
    throw new Error('[FEEDBACK_CANDIDATE_INVALID] Invalid candidate id');
}
/** @deprecated D8: path of a read-only legacy candidate file (migration input only). */
export function executionFeedbackCandidatePath(id: string, scope?: MemoryScopeEnvelope): string {
  assertCandidateId(id);
  return scope
    ? path.join(executionFeedbackScopeRoot(scope), 'candidates', id + '.json')
    : pathResolver.shared('runtime/distill-candidates/' + id + '.json');
}
function catalog(filePath: string) {
  return defineCatalog<DistillCandidateRecord>({
    id: 'execution-feedback-candidate',
    path: filePath,
    schema: pathResolver.knowledge('product/schemas/distill-candidate-record.schema.json'),
  });
}
function legacyView(row: DistillCandidateRecord): ExecutionFeedbackCandidate {
  return {
    candidate_id: row.candidate_id,
    source_type: row.source_type,
    tier: row.tier || row.scope?.tier || 'personal',
    ...(row.mission_id ? { mission_id: row.mission_id } : {}),
    ...(row.task_session_id ? { task_session_id: row.task_session_id } : {}),
    title: row.title,
    summary: row.summary,
    status: row.status,
    target_kind: row.target_kind,
    ...(row.locale ? { locale: row.locale } : {}),
    ...(row.promoted_ref ? { promoted_ref: row.promoted_ref } : {}),
    evidence_refs: row.evidence_refs || [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata: row.metadata || {},
    ...(row.scope ? { scope: row.scope } : {}),
    legacy_read_only: true,
  };
}
/** Read-only legacy record (unscoped global store, or a scoped candidates/ file). */
function loadLegacyExecutionFeedbackCandidate(
  id: string,
  scope?: MemoryScopeEnvelope
): DistillCandidateRecord | null {
  let candidatePath: string;
  try {
    candidatePath = executionFeedbackCandidatePath(id, scope);
  } catch (error) {
    // Owner-only scopes never had a legacy feedback directory.
    if (error instanceof Error && error.message.startsWith('[FEEDBACK_SCOPE_UNSUPPORTED]'))
      return null;
    throw error;
  }
  const file = assertSafeRepositoryPath(candidatePath, { allowMissingLeaf: true });
  if (!safeExistsSync(file)) return null;
  if (!safeLstat(file).isFile())
    throw new Error('[FEEDBACK_CANDIDATE_INVALID] Expected a regular candidate file');
  const row = scope ? catalog(file).load() : loadDistillCandidateRecord(id);
  if (
    !row ||
    row.metadata?.improvement_kind !== 'execution_feedback' ||
    executionFeedbackScopeKey(row.scope) !== executionFeedbackScopeKey(scope)
  )
    return null;
  return row;
}
function listLegacyExecutionFeedbackCandidates(
  scope?: MemoryScopeEnvelope
): DistillCandidateRecord[] {
  if (!scope)
    return listDistillCandidateRecords().filter(
      (row) => !row.scope && row.metadata?.improvement_kind === 'execution_feedback'
    );
  let dir: string;
  try {
    dir = path.join(executionFeedbackScopeRoot(scope), 'candidates');
  } catch {
    return [];
  }
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => loadLegacyExecutionFeedbackCandidate(name.slice(0, -5), scope))
    .filter((row): row is DistillCandidateRecord => Boolean(row));
}
function queuedInScope(scope?: MemoryScopeEnvelope): ExecutionFeedbackCandidate[] {
  const key = executionFeedbackScopeKey(scope);
  return listFacadeProposals(EXECUTION_FEEDBACK_PROPOSAL, scope).filter(
    (row) =>
      row.metadata?.improvement_kind === 'execution_feedback' &&
      executionFeedbackScopeKey(row.scope) === key
  );
}

export function loadExecutionFeedbackCandidate(
  id: string,
  scope?: MemoryScopeEnvelope
): ExecutionFeedbackCandidate | null {
  assertCandidateId(id);
  const queued = queuedInScope(scope).find((row) => row.candidate_id === id);
  if (queued) return queued;
  const legacy = loadLegacyExecutionFeedbackCandidate(id, scope);
  return legacy ? legacyView(legacy) : null;
}
/** Queue-backed proposals of this exact scope plus legacy items not yet migrated. */
export function listExecutionFeedbackCandidates(
  scope?: MemoryScopeEnvelope
): ExecutionFeedbackCandidate[] {
  const queued = queuedInScope(scope);
  const seen = new Set(queued.map((row) => row.candidate_id));
  return [
    ...queued,
    ...listLegacyExecutionFeedbackCandidates(scope)
      .filter((row) => !seen.has(row.candidate_id))
      .map(legacyView),
  ].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export type ExecutionFeedbackCandidateInput = Omit<
  FacadeProposalRecord,
  'created_at' | 'updated_at' | 'candidate_id' | 'tier'
> & {
  candidate_id?: string;
  created_at?: string;
  updated_at?: string;
  tier?: FacadeProposalRecord['tier'];
  legacy_read_only?: true;
};

/**
 * Capture a new proposal on the queue, or update the queue row of the same id
 * in the same scope. Scope is required (`MEMORY_SCOPE_REQUIRED`); legacy
 * read-only records are never rewritten.
 */
export function saveExecutionFeedbackCandidate(
  row: ExecutionFeedbackCandidateInput
): ExecutionFeedbackCandidate {
  if (row.metadata?.improvement_kind !== 'execution_feedback')
    throw new Error('[FEEDBACK_CANDIDATE_INVALID] Expected execution feedback');
  if (!row.scope)
    throw new Error(
      '[MEMORY_SCOPE_REQUIRED] execution-feedback proposal has no scope — legacy unscoped records are read-only and new ones are not captured | next: record the feedback with an explicit scope'
    );
  executionFeedbackScopeKey(row.scope);
  if (row.tier && row.tier !== row.scope.tier)
    throw new Error('[FEEDBACK_SCOPE_MISMATCH] Candidate tier differs from scope');
  const existing = row.candidate_id
    ? queuedInScope(row.scope).find((entry) => entry.candidate_id === row.candidate_id)
    : undefined;
  if (existing) {
    const updated = updateFacadeProposal(
      EXECUTION_FEEDBACK_PROPOSAL,
      existing.candidate_id,
      {
        ...(row.status !== existing.status ? { status: row.status } : {}),
        ...(row.promoted_ref ? { promoted_ref: row.promoted_ref } : {}),
        title: row.title,
        summary: row.summary,
        evidence_refs: row.evidence_refs,
        metadata: row.metadata,
      },
      { scope: existing.scope || row.scope }
    );
    if (!updated) throw new Error('[FEEDBACK_CANDIDATE_NOT_FOUND] Candidate changed during update');
    return updated;
  }
  if (
    row.legacy_read_only ||
    (row.candidate_id && loadLegacyExecutionFeedbackCandidate(row.candidate_id, row.scope))
  )
    throw new Error(
      '[FEEDBACK_CANDIDATE_READ_ONLY] Legacy execution-feedback records are read-only | next: pnpm kyberion improvements --migrate --write'
    );
  return captureFacadeProposal(EXECUTION_FEEDBACK_PROPOSAL, {
    ...(row.candidate_id ? { candidate_id: row.candidate_id } : {}),
    ...(row.created_at ? { created_at: row.created_at } : {}),
    status: row.status,
    source_type: row.source_type,
    ...(row.mission_id ? { mission_id: row.mission_id } : {}),
    ...(row.task_session_id ? { task_session_id: row.task_session_id } : {}),
    title: row.title,
    summary: row.summary,
    target_kind: row.target_kind,
    ...(row.locale ? { locale: row.locale } : {}),
    ...(row.promoted_ref ? { promoted_ref: row.promoted_ref } : {}),
    evidence_refs: row.evidence_refs,
    metadata: row.metadata,
    scope: row.scope,
    proposedMemoryKind: 'sop',
  });
}

export interface ExecutionFeedbackMigrationReport {
  mode: 'dry_run' | 'apply';
  imported: Array<{ candidate_id: string; status: string; tenant_slug?: string }>;
  already_on_queue: string[];
  /** Pending legacy items without a recorded scope — reported, never guessed. */
  unresolved: Array<{ candidate_id: string; reason: string }>;
  /** Promoted / archived records stay read-only history. */
  left_as_history: string[];
}

/**
 * One-release migration: import pending legacy proposals with the scope the
 * record itself declares. `scopes` names the scoped legacy stores to read
 * (they are keyed by scope and cannot be enumerated); the unscoped global
 * store is always read and its pending items are reported as unresolved.
 */
export function migrateLegacyExecutionFeedbackCandidates(
  options: { apply?: boolean; scopes?: MemoryScopeEnvelope[] } = {}
): ExecutionFeedbackMigrationReport {
  const report: ExecutionFeedbackMigrationReport = {
    mode: options.apply ? 'apply' : 'dry_run',
    imported: [],
    already_on_queue: [],
    unresolved: [],
    left_as_history: [],
  };
  const sources: Array<{ scope?: MemoryScopeEnvelope; rows: DistillCandidateRecord[] }> = [
    { rows: listLegacyExecutionFeedbackCandidates() },
    ...(options.scopes || []).map((scope) => ({
      scope,
      rows: listLegacyExecutionFeedbackCandidates(scope),
    })),
  ];
  for (const { scope, rows } of sources) {
    const onQueue = new Set(queuedInScope(scope).map((row) => row.candidate_id));
    for (const record of rows) {
      if (record.status !== 'proposed') {
        report.left_as_history.push(record.candidate_id);
        continue;
      }
      if (onQueue.has(record.candidate_id)) {
        report.already_on_queue.push(record.candidate_id);
        continue;
      }
      if (!record.scope) {
        report.unresolved.push({
          candidate_id: record.candidate_id,
          reason:
            '[MEMORY_SCOPE_REQUIRED] legacy unscoped proposal records no scope; re-submit the feedback in an explicit scope',
        });
        continue;
      }
      if (options.apply)
        captureFacadeProposal(EXECUTION_FEEDBACK_PROPOSAL, {
          candidate_id: record.candidate_id,
          created_at: record.created_at,
          status: 'proposed',
          source_type: record.source_type,
          ...(record.mission_id ? { mission_id: record.mission_id } : {}),
          ...(record.task_session_id ? { task_session_id: record.task_session_id } : {}),
          title: record.title,
          summary: record.summary,
          target_kind: record.target_kind,
          ...(record.locale ? { locale: record.locale } : {}),
          evidence_refs: record.evidence_refs?.length
            ? record.evidence_refs
            : [`execution-feedback-candidate:${record.candidate_id}`],
          metadata: record.metadata || {},
          scope: record.scope,
          proposedMemoryKind: 'sop',
          migratedFrom: LEGACY_DISTILL_CANDIDATE_STORE,
        });
      report.imported.push({
        candidate_id: record.candidate_id,
        status: record.status,
        ...(record.scope.tenant_slug ? { tenant_slug: record.scope.tenant_slug } : {}),
      });
    }
  }
  return report;
}
