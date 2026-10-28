/**
 * HA-01 archive-only curator for background-review output.
 *
 * The curator is deterministic and never asks a model to decide what to
 * delete. It only archives stale proposal records that carry the exact
 * background-review provenance marker. Bundled, manually authored, promoted,
 * and otherwise unprovenanced records are protected by default.
 */

import { assertBackgroundReviewOperationAllowed } from './background-review-policy.js';
import { listApprovalRequests } from '../governance/approval-store-reader.js';
import type { MemoryScopeEnvelope } from '../knowledge/memory-scope.js';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReaddir } from '../secure-io.js';
import { readTextFile } from '../foundation/text.js';
import { runtimeStatePath } from '../foundation/runtime-state-roots.js';
import { assertMemoryScope } from '../knowledge/memory-scope.js';
import {
  loadDistillCandidateRecord,
  listDistillCandidateRecords,
  mutateDistillCandidateRecord,
  type DistillCandidateRecord,
} from '../knowledge/distill-candidate-registry.js';

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const BACKGROUND_REVIEW_ORIGIN = 'background_review_fork';
const BACKGROUND_REVIEW_GENERATOR = 'background-review-fork';

export interface BackgroundReviewCuratorInput {
  now?: Date;
  maxAgeMs?: number;
  limit?: number;
  dryRun?: boolean;
  /** Exact storage scope; omitted addresses only the legacy candidate registry. */
  scope?: MemoryScopeEnvelope;
}

export interface BackgroundReviewCuratorResult {
  scanned: number;
  eligible: number;
  archived: string[];
  would_archive: string[];
  protected_records: string[];
  protected_reasons: Record<string, string[]>;
  skipped_fresh: string[];
  skipped_invalid_timestamp: string[];
}

/** Maintenance consent is separate from immutable generation provenance. */
interface ProposalMaintenance {
  pinned?: boolean;
  automatic_archive?: boolean;
  last_used_at?: string;
  updated_by?: string;
  updated_at?: string;
}

function maintenanceFor(record: DistillCandidateRecord): ProposalMaintenance | null {
  const value = record.metadata?.maintenance;
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (
    (fields.pinned !== undefined && typeof fields.pinned !== 'boolean') ||
    (fields.automatic_archive !== undefined && typeof fields.automatic_archive !== 'boolean') ||
    (fields.last_used_at !== undefined &&
      (typeof fields.last_used_at !== 'string' ||
        !Number.isFinite(Date.parse(fields.last_used_at))))
  )
    return null;
  return fields as ProposalMaintenance;
}

function sameApprovalScope(
  record: DistillCandidateRecord,
  approvalScope: ReturnType<typeof listApprovalRequests>[number]['scope']
): boolean {
  if (!record.scope || !approvalScope) return !record.scope && !approvalScope;
  if (record.scope.owner_nhi && record.scope.owner_nhi !== approvalScope.nhi_id) return false;
  return (
    [
      'tier',
      'tenant_slug',
      'organization_id',
      'project_id',
      'mission_id',
      'task_id',
      'session_id',
    ] as const
  ).every((field) => record.scope?.[field] === approvalScope[field]);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function isBackgroundReviewProposal(record: DistillCandidateRecord): boolean {
  const metadata = record.metadata;
  if (!metadata || metadata.origin !== BACKGROUND_REVIEW_ORIGIN) return false;
  const provenance = metadata.provenance;
  return Boolean(
    provenance &&
    typeof provenance === 'object' &&
    (provenance as Record<string, unknown>).generated_by === BACKGROUND_REVIEW_GENERATOR
  );
}

function timestampFor(record: DistillCandidateRecord): number {
  const used = maintenanceFor(record)?.last_used_at;
  return Math.max(
    Date.parse(String(record.updated_at || record.created_at || '')),
    used ? Date.parse(used) : 0
  );
}

/** Read only public catalogs and this tenant's catalog; an incomplete scan protects all records. */
function retentionReferences(scope?: MemoryScopeEnvelope): {
  values: Set<string>;
  complete: boolean;
} {
  const values = new Set<string>();
  let complete = true;
  let files = 0;
  const roots = [
    'pipelines',
    'knowledge/product/pipeline-templates',
    runtimeStatePath('pipeline.scheduleRegistry').physicalPath,
    'knowledge/product/orchestration/procedures.json',
  ];
  if (scope) {
    const canonical = assertMemoryScope(scope);
    if (canonical.tenant_slug)
      roots.push(`knowledge/confidential/${canonical.tenant_slug}/pipelines`);
  }
  const collect = (value: unknown): void => {
    if (typeof value === 'string') values.add(value.replace(/^\.\//, ''));
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  const visit = (relative: string, depth = 0): void => {
    if (depth > 12 || files > 2048) {
      complete = false;
      return;
    }
    const absolute = assertSafeRepositoryPath(pathResolver.rootResolve(relative), {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(absolute)) return;
    const stat = safeLstat(absolute);
    if (stat.isSymbolicLink()) {
      complete = false;
      return;
    }
    if (stat.isDirectory()) {
      for (const name of safeReaddir(absolute)) visit(path.posix.join(relative, name), depth + 1);
    } else if (stat.isFile() && relative.endsWith('.json')) {
      files += 1;
      if (stat.size > 2 * 1024 * 1024) {
        complete = false;
        return;
      }
      try {
        collect(JSON.parse(readTextFile(absolute)));
      } catch {
        complete = false;
      }
    }
  };
  for (const root of roots) {
    try {
      visit(root);
    } catch {
      complete = false;
    }
  }
  return { values, complete };
}

function referenceProtection(
  record: DistillCandidateRecord,
  references: ReturnType<typeof retentionReferences>
): string[] {
  if (!references.complete) return ['reference_scan_incomplete'];
  const refs = [
    record.candidate_id,
    `candidate:${record.candidate_id}`,
    record.promoted_ref,
    typeof record.metadata?.target_ref === 'string' ? record.metadata.target_ref : undefined,
  ];
  return refs.some((ref) => ref && references.values.has(ref)) ? ['referenced_by_workflow'] : [];
}

export interface BackgroundReviewMaintenanceInput {
  candidateId: string;
  actorId: string;
  scope?: MemoryScopeEnvelope;
  dryRun?: boolean;
  now?: Date;
}

export interface BackgroundReviewMaintenanceResult {
  candidate_id: string;
  status: DistillCandidateRecord['status'];
  changed: boolean;
  dry_run: boolean;
  pinned: boolean;
  automatic_archive: boolean;
}

function maintenanceRecord(
  input: BackgroundReviewMaintenanceInput,
  record = loadDistillCandidateRecord(input.candidateId, input.scope)
): DistillCandidateRecord {
  if (!input.actorId.trim() || input.actorId.length > 200 || /[\r\n\u0000]/u.test(input.actorId))
    throw new Error('[BACKGROUND_REVIEW_MAINTENANCE] A bounded actor id is required');
  if (!record || !isBackgroundReviewProposal(record) || record.status === 'promoted')
    throw new Error('[BACKGROUND_REVIEW_MAINTENANCE] Eligible proposal not found in this scope');
  if (!maintenanceFor(record))
    throw new Error(
      '[BACKGROUND_REVIEW_MAINTENANCE] Invalid maintenance metadata; repair before changing it'
    );
  return record;
}

function maintainProposal(
  input: BackgroundReviewMaintenanceInput,
  transform: (record: DistillCandidateRecord) => DistillCandidateRecord
): BackgroundReviewMaintenanceResult {
  let result: BackgroundReviewMaintenanceResult | undefined;
  const mutate = (record: DistillCandidateRecord) => {
    const next = transform(maintenanceRecord(input, record));
    const changed = next !== record;
    result = maintenanceResult(next, changed, input.dryRun);
    return changed ? { status: next.status, metadata: next.metadata } : null;
  };
  if (input.dryRun) mutate(maintenanceRecord(input));
  else mutateDistillCandidateRecord(input.candidateId, mutate, input.scope);
  if (!result)
    throw new Error('[BACKGROUND_REVIEW_MAINTENANCE] Eligible proposal not found in this scope');
  return result;
}

function maintenanceResult(
  record: DistillCandidateRecord,
  changed: boolean,
  dryRun = false
): BackgroundReviewMaintenanceResult {
  const maintenance = maintenanceFor(record);
  return {
    candidate_id: record.candidate_id,
    status: record.status,
    changed,
    dry_run: dryRun,
    pinned: maintenance?.pinned === true,
    automatic_archive: maintenance?.automatic_archive === true,
  };
}

/** Pin/opt out without rewriting who authored the proposal or granting approval. */
export function setBackgroundReviewProposalMaintenance(
  input: BackgroundReviewMaintenanceInput & { pinned?: boolean; automaticArchive?: boolean }
): BackgroundReviewMaintenanceResult {
  if (
    (input.pinned !== undefined && typeof input.pinned !== 'boolean') ||
    (input.automaticArchive !== undefined && typeof input.automaticArchive !== 'boolean')
  )
    throw new Error('[BACKGROUND_REVIEW_MAINTENANCE] Maintenance settings must be boolean');
  if (input.pinned === undefined && input.automaticArchive === undefined)
    throw new Error('[BACKGROUND_REVIEW_MAINTENANCE] A maintenance setting is required');
  return maintainProposal(input, (record) => {
    const previous = maintenanceFor(record) as ProposalMaintenance;
    const maintenance: ProposalMaintenance = {
      ...previous,
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.automaticArchive !== undefined
        ? { automatic_archive: input.automaticArchive }
        : {}),
      updated_by: input.actorId.trim(),
      updated_at: (input.now || new Date()).toISOString(),
    };
    const changed =
      previous.pinned !== maintenance.pinned ||
      previous.automatic_archive !== maintenance.automatic_archive;
    return changed ? { ...record, metadata: { ...record.metadata, maintenance } } : record;
  });
}

/** Restore a curator archive to review, never apply or approve its proposed changes. */
export function restoreBackgroundReviewProposal(
  input: BackgroundReviewMaintenanceInput
): BackgroundReviewMaintenanceResult {
  return maintainProposal(input, (record) => {
    const archive = record.metadata?.archive;
    if (
      record.status !== 'archived' ||
      !archive ||
      typeof archive !== 'object' ||
      (archive as Record<string, unknown>).reversible !== true ||
      (archive as Record<string, unknown>).previous_status !== 'proposed' ||
      (archive as Record<string, unknown>).reason !==
        'background-review curator stale proposal retention'
    )
      throw new Error(
        '[BACKGROUND_REVIEW_MAINTENANCE] Only reversible curator archives can be restored'
      );
    const now = (input.now || new Date()).toISOString();
    const metadata = {
      ...record.metadata,
      archive: { ...archive, restored_at: now, restored_by: input.actorId.trim() },
      maintenance: {
        ...maintenanceFor(record),
        last_used_at: now,
        updated_at: now,
        updated_by: input.actorId.trim(),
      },
    };
    return { ...record, status: 'proposed', metadata };
  });
}

/**
 * Archive stale, agent-created proposals while preserving their record and
 * provenance. A later human/control-plane action can restore an archived
 * record by changing its status back to `proposed`.
 */
export function curateBackgroundReviewProposals(
  input: BackgroundReviewCuratorInput = {}
): BackgroundReviewCuratorResult {
  assertBackgroundReviewOperationAllowed('memory:archive');
  const now = input.now || new Date();
  const nowMs = now.getTime();
  const maxAgeMs = positiveInteger(input.maxAgeMs, DEFAULT_MAX_AGE_MS);
  const limit = positiveInteger(input.limit, DEFAULT_LIMIT);
  if (!Number.isFinite(nowMs)) throw new Error('[BACKGROUND_REVIEW_CURATOR] Invalid now timestamp');
  const records = listDistillCandidateRecords(input.scope);
  const references = retentionReferences(input.scope);
  // The existing approval store is authoritative for work awaiting a decision or
  // application. Do not archive a proposal out from under either state.
  const listActiveApprovals = () =>
    listApprovalRequests({
      storageChannels: ['background-review'],
      status: ['pending', 'approved'],
      ...(input.scope ? { scope: input.scope } : {}),
    });
  const hasActiveApproval = (
    record: DistillCandidateRecord,
    approvals: ReturnType<typeof listActiveApprovals>
  ) =>
    approvals.some(
      (approval) =>
        approval.correlationId === record.candidate_id && sameApprovalScope(record, approval.scope)
    );
  const approvals = records.some(
    (record) => record.status === 'proposed' && isBackgroundReviewProposal(record)
  )
    ? listActiveApprovals()
    : [];
  const result: BackgroundReviewCuratorResult = {
    scanned: records.length,
    eligible: 0,
    archived: [],
    would_archive: [],
    protected_records: [],
    protected_reasons: {},
    skipped_fresh: [],
    skipped_invalid_timestamp: [],
  };

  for (const record of records) {
    const reasons: string[] = [];
    if (record.status !== 'proposed' || !isBackgroundReviewProposal(record)) {
      reasons.push('not_managed_proposal');
    }
    const maintenance = maintenanceFor(record);
    if (!maintenance) reasons.push('invalid_maintenance');
    if (maintenance?.pinned) reasons.push('pinned');
    if (maintenance?.automatic_archive !== true) reasons.push('automatic_archive_disabled');
    reasons.push(...referenceProtection(record, references));
    if (hasActiveApproval(record, approvals)) reasons.push('active_approval');
    if (reasons.length) {
      result.protected_records.push(record.candidate_id);
      result.protected_reasons[record.candidate_id] = reasons;
      continue;
    }
    result.eligible += 1;
    if (result.would_archive.length >= limit) continue;
    const timestamp = timestampFor(record);
    if (!Number.isFinite(timestamp)) {
      result.skipped_invalid_timestamp.push(record.candidate_id);
      continue;
    }
    if (nowMs - timestamp < maxAgeMs) {
      result.skipped_fresh.push(record.candidate_id);
      continue;
    }

    result.would_archive.push(record.candidate_id);
    if (input.dryRun) continue;

    let archived = false;
    mutateDistillCandidateRecord(
      record.candidate_id,
      (current) => {
        const liveMaintenance = maintenanceFor(current);
        const timestamp = timestampFor(current);
        if (
          current.status !== 'proposed' ||
          !isBackgroundReviewProposal(current) ||
          !liveMaintenance ||
          liveMaintenance.pinned ||
          liveMaintenance.automatic_archive !== true ||
          !Number.isFinite(timestamp) ||
          nowMs - timestamp < maxAgeMs
        )
          return null;
        // Approval request creation holds this same candidate lock. Re-read
        // references here, rather than trusting the earlier scan snapshot.
        if (hasActiveApproval(current, listActiveApprovals())) return null;
        if (referenceProtection(current, retentionReferences(input.scope)).length) return null;
        archived = true;
        return {
          status: 'archived',
          metadata: {
            ...(current.metadata || {}),
            archive: {
              archived_at: now.toISOString(),
              previous_status: current.status,
              reason: 'background-review curator stale proposal retention',
              reversible: true,
            },
          },
        };
      },
      input.scope
    );
    if (archived) result.archived.push(record.candidate_id);
    else {
      result.would_archive.pop();
      result.protected_records.push(record.candidate_id);
      result.protected_reasons[record.candidate_id] = ['record_changed'];
    }
  }

  return result;
}
