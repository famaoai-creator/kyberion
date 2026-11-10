/**
 * D8 / MEMORY_LOOP_CLOSURE M2: the last producers of proposed
 * DistillCandidateRecords moved onto the one MemoryCandidate queue.
 *
 * - Learning intake plans (`pnpm kyberion learning prepare`) — origin
 *   `learning_intake`, handed to steward review with `--queue`.
 * - Service procedure candidates (`service_recording candidate`) — origin
 *   `service_procedure`, decided on the Concierge reuse-proposal panel.
 * - Mission-seed reuse proposals (Concierge mission-seed promotion) — origin
 *   `mission_seed`, decided on the same panel.
 * - Completed browser-extension runs are plain personal learnings on the
 *   queue (no origin; the personal promotion path decides them).
 *
 * Scope is written at capture from the producer's real scope. The legacy
 * records stay read-only history; for one release
 * {@link migrateLegacyReuseProposals} imports the pending ones with the scope
 * the record itself declares (its scope envelope, its plan's scope, or its
 * mission's persisted state) and reports the rest as unresolved — it never
 * guesses a scope.
 */

import {
  CONCIERGE_DECIDED_VIA,
  captureFacadeProposal,
  LEGACY_DISTILL_CANDIDATE_STORE,
  listFacadeProposals,
  type FacadeProposalRecord,
  type FacadeProposalSpec,
} from './facade-proposal-rows.js';
import {
  listDistillCandidateRecords,
  listDistillCandidateRecordsForTenants,
  type DistillCandidateRecord,
} from './distill-candidate-registry.js';
import { missionMemoryCaptureScope } from './memory-capture-scope.js';
import { assertMemoryScope, type MemoryScopeEnvelope } from './memory-scope.js';
import type { MemoryCandidateKind } from './memory-promotion-queue.js';
import { listTenantProfileSlugs } from '../organization/tenant-registry.js';

export const LEARNING_INTAKE_PROPOSAL: FacadeProposalSpec = {
  recordKind: 'learning_intake',
  learningKind: 'lesson',
  decidedVia: 'pnpm kyberion learning prepare --queue',
  idPrefix: 'DSC-LEARN',
};

export const SERVICE_PROCEDURE_PROPOSAL: FacadeProposalSpec = {
  recordKind: 'service_procedure',
  learningKind: 'lesson',
  decidedVia: CONCIERGE_DECIDED_VIA,
  idPrefix: 'DSC-SVC',
};

export const MISSION_SEED_PROPOSAL: FacadeProposalSpec = {
  recordKind: 'mission_seed',
  learningKind: 'lesson',
  decidedVia: CONCIERGE_DECIDED_VIA,
  idPrefix: 'DSC-SEED',
};

const SPEC_BY_KIND = {
  learning_intake: LEARNING_INTAKE_PROPOSAL,
  service_procedure: SERVICE_PROCEDURE_PROPOSAL,
  mission_seed: MISSION_SEED_PROPOSAL,
} as const;
type ReuseProposalKind = keyof typeof SPEC_BY_KIND;

/** Knowledge format a legacy target kind stands for on the queue. */
export function proposedMemoryKindForTarget(
  targetKind: DistillCandidateRecord['target_kind']
): MemoryCandidateKind {
  if (targetKind === 'knowledge_hint') return 'heuristic';
  if (targetKind === 'pattern' || targetKind === 'report_template') return 'template';
  return 'sop';
}

/**
 * Capture scope of a mission-seed reuse proposal: the started mission's own
 * persisted tier and tenant, narrowed to the project (and its organization)
 * when the project belongs to that tenant and organization. Undefined (not
 * captured) for a non-public mission without a tenant in its state.
 */
export function missionSeedProposalScope(
  missionId: string,
  project?: { project_id?: string; tenant_slug?: string; organization_id?: string }
): MemoryScopeEnvelope | undefined {
  const captured = missionMemoryCaptureScope(missionId);
  if (!captured.scope) return captured.tier === 'public' ? { tier: 'public' } : undefined;
  const scope = captured.scope;
  const sameEntity =
    project?.project_id &&
    project.organization_id &&
    project.tenant_slug === scope.tenant_slug &&
    (!scope.organization_id || scope.organization_id === project.organization_id);
  return sameEntity
    ? { ...scope, organization_id: project.organization_id, project_id: project.project_id }
    : scope;
}

export interface CaptureMissionSeedProposalInput {
  missionId: string;
  project: {
    project_id: string;
    tenant_slug?: string;
    organization_id?: string;
    primary_locale?: string;
  };
  seed: {
    seed_id: string;
    title: string;
    track_id?: string;
    track_name?: string;
    source_task_session_id?: string;
    specialist_id?: string;
    locale?: string;
    work_loop?: unknown;
  };
  targetKind: DistillCandidateRecord['target_kind'];
  metadata: Record<string, unknown>;
}

/** Capture the reuse proposal of a promoted mission seed; null when it has no scope. */
export function captureMissionSeedProposal(
  input: CaptureMissionSeedProposalInput
): FacadeProposalRecord | null {
  const scope = missionSeedProposalScope(input.missionId, input.project);
  if (!scope) return null;
  const { seed, project, missionId } = input;
  const locale = seed.locale || project.primary_locale;
  return captureFacadeProposal(MISSION_SEED_PROPOSAL, {
    source_type: 'mission',
    scope,
    proposedMemoryKind: proposedMemoryKindForTarget(input.targetKind),
    project_id: project.project_id,
    ...(seed.track_id ? { track_id: seed.track_id } : {}),
    ...(seed.track_name ? { track_name: seed.track_name } : {}),
    mission_id: missionId,
    ...(seed.source_task_session_id ? { task_session_id: seed.source_task_session_id } : {}),
    ...(seed.specialist_id ? { specialist_id: seed.specialist_id } : {}),
    ...(locale ? { locale } : {}),
    ...(seed.work_loop && typeof seed.work_loop === 'object'
      ? { work_loop: seed.work_loop as Record<string, unknown> }
      : {}),
    title: `Promote durable mission orchestration for ${seed.title}`,
    summary: `${seed.title} was promoted from a project mission seed into durable mission ${missionId}. This transition may be reusable as governed organizational memory.`,
    target_kind: input.targetKind,
    evidence_refs: [
      `project:${project.project_id}`,
      `mission_seed:${seed.seed_id}`,
      `mission:${missionId}`,
      ...(seed.source_task_session_id ? [`task_session:${seed.source_task_session_id}`] : []),
    ],
    metadata: input.metadata,
  });
}

function legacyKind(record: DistillCandidateRecord): ReuseProposalKind | 'browser' | null {
  const metadata = record.metadata || {};
  if (metadata.origin === 'learning_intake') return 'learning_intake';
  if (metadata.promotion_source === 'mission_seed') return 'mission_seed';
  if (metadata.surface === 'browser-extension') return 'browser';
  if (record.target_kind === 'procedure' && metadata.procedure && metadata.executable === false)
    return 'service_procedure';
  return null;
}

/** The scope the legacy record itself declares; throws when it declares none. */
function declaredScope(
  record: DistillCandidateRecord,
  kind: ReuseProposalKind
): MemoryScopeEnvelope {
  if (record.scope) return assertMemoryScope(record.scope, record.scope.tier);
  if (kind === 'learning_intake') {
    const plan = record.metadata?.learning_plan as { scope?: MemoryScopeEnvelope } | undefined;
    // Pre-D8 public plans were stored unscoped on purpose; their plan names the scope.
    if (plan?.scope?.tier === 'public' && record.tier === 'public')
      return assertMemoryScope(plan.scope, 'public');
  }
  if (kind === 'mission_seed' && record.mission_id) {
    const scope = missionSeedProposalScope(record.mission_id, {
      ...(record.project_id ? { project_id: record.project_id } : {}),
    });
    if (scope) return scope;
    throw new Error(
      `[MEMORY_SCOPE_REQUIRED] mission ${record.mission_id} has no tenant scope in its state`
    );
  }
  throw new Error('[MEMORY_SCOPE_REQUIRED] the legacy record declares no scope');
}

export interface ReuseProposalMigrationReport {
  mode: 'dry_run' | 'apply';
  imported: Array<{ candidate_id: string; record_kind: ReuseProposalKind; tenant_slug?: string }>;
  already_on_queue: string[];
  unresolved: Array<{ candidate_id: string; reason: string }>;
  left_as_history: string[];
}

function legacyRecords(): DistillCandidateRecord[] {
  const seen = new Set<string>();
  const tenantSlugs = (() => {
    try {
      return listTenantProfileSlugs();
    } catch {
      return [];
    }
  })();
  return [
    ...listDistillCandidateRecords(),
    ...(tenantSlugs.length
      ? listDistillCandidateRecordsForTenants({
          tenantSlugs,
          tierAccess: ['public', 'confidential'],
        })
      : []),
  ].filter((record) => {
    const key = `${record.candidate_id}:${JSON.stringify(record.scope || null)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * One-release migration: import pending (proposed) legacy learning-intake,
 * service-procedure and mission-seed records onto the queue with the scope the
 * record declares. Browser-extension records never recorded an owner, so they
 * stay history (`unresolved`). Personal owner partitions are not enumerable and
 * are not scanned.
 */
export function migrateLegacyReuseProposals(
  options: { apply?: boolean } = {}
): ReuseProposalMigrationReport {
  const report: ReuseProposalMigrationReport = {
    mode: options.apply ? 'apply' : 'dry_run',
    imported: [],
    already_on_queue: [],
    unresolved: [],
    left_as_history: [],
  };
  const onQueue = new Set(
    (Object.keys(SPEC_BY_KIND) as ReuseProposalKind[]).flatMap((kind) =>
      listFacadeProposals(SPEC_BY_KIND[kind]).map((row) => `${kind}:${row.candidate_id}`)
    )
  );
  for (const record of legacyRecords()) {
    const kind = legacyKind(record);
    if (!kind) continue;
    if (record.status !== 'proposed') {
      report.left_as_history.push(record.candidate_id);
      continue;
    }
    if (kind === 'browser') {
      report.unresolved.push({
        candidate_id: record.candidate_id,
        reason:
          '[MEMORY_SCOPE_REQUIRED] browser-extension record names no owner; new runs are captured for the local owner',
      });
      continue;
    }
    if (onQueue.has(`${kind}:${record.candidate_id}`)) {
      report.already_on_queue.push(record.candidate_id);
      continue;
    }
    let scope: MemoryScopeEnvelope;
    try {
      scope = declaredScope(record, kind);
    } catch (err) {
      report.unresolved.push({
        candidate_id: record.candidate_id,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (options.apply)
      captureFacadeProposal(SPEC_BY_KIND[kind], {
        candidate_id: record.candidate_id,
        created_at: record.created_at,
        source_type: record.source_type,
        ...(record.mission_id ? { mission_id: record.mission_id } : {}),
        ...(record.task_session_id ? { task_session_id: record.task_session_id } : {}),
        ...(record.project_id ? { project_id: record.project_id } : {}),
        ...(record.track_id ? { track_id: record.track_id } : {}),
        ...(record.track_name ? { track_name: record.track_name } : {}),
        ...(record.specialist_id ? { specialist_id: record.specialist_id } : {}),
        ...(record.locale ? { locale: record.locale } : {}),
        ...(record.work_loop
          ? { work_loop: record.work_loop as unknown as Record<string, unknown> }
          : {}),
        title: record.title,
        summary: record.summary,
        target_kind: record.target_kind,
        evidence_refs: record.evidence_refs?.length
          ? record.evidence_refs
          : [`distill-candidate:${record.candidate_id}`],
        metadata: record.metadata || {},
        scope,
        proposedMemoryKind: proposedMemoryKindForTarget(record.target_kind),
        migratedFrom: LEGACY_DISTILL_CANDIDATE_STORE,
      });
    report.imported.push({
      candidate_id: record.candidate_id,
      record_kind: kind,
      ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
    });
  }
  return report;
}
