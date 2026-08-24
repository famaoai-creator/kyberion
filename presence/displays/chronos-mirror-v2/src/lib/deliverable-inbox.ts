import path from 'node:path';
import { listArtifactRecords, type ArtifactRecord } from '@agent/core/artifact-record';
import { listInboxEntries, type DeliverableInboxEntry } from '@agent/core';
import { findMissionPath, pathResolver } from '@agent/core/path-resolver';
import { loadJson, safeExistsSync, safeStat } from '@agent/core/secure-io';
import { loadDeliverableReviewState } from './deliverable-review';

export interface DeliverableInboxItem {
  artifactId: string;
  /** True when the record points at a local file that no longer exists. */
  missing?: boolean;
  /**
   * How many older artifact records describe this same deliverable. Test
   * fixtures and repeated pipeline runs register a fresh artifact_id per run
   * against an unchanged path, so the raw record list is mostly duplicates
   * (96 of 103 records on the reference workspace pointed at two files).
   * Only the newest record per target survives; this is the collapsed count.
   */
  supersededCount?: number;
  missionId?: string;
  projectId?: string;
  tenantSlug?: string;
  organizationId?: string;
  trackId?: string;
  trackName?: string;
  kind: string;
  storageClass: ArtifactRecord['storage_class'];
  path?: string;
  externalRef?: string;
  previewText?: string;
  missionStatus?: string;
  updatedAt: string;
  sizeBytes?: number;
  reviewVerdict?: string;
  reviewComment?: string;
  reviewVersion?: number;
  reviewCurrentArtifactId?: string;
  /** CE-07: role-separated claims carried from the governed inbox record. */
  roleSections?: DeliverableInboxEntry['role_sections'];
  integratedSummary?: string;
}

export interface DeliverableInboxQuery {
  query?: string;
  missionId?: string;
  kind?: string;
  tier?: 'personal' | 'confidential' | 'public' | '';
  tenantSlugs?: string[] | 'all';
  organizationIds?: string[] | 'all';
  projectIds?: string[] | 'all';
  limit?: number;
}

function readMissionStatus(missionId?: string): string | undefined {
  if (!missionId) return undefined;
  const missionPath = findMissionPath(missionId.toUpperCase());
  if (!missionPath) return undefined;
  const statePath = path.join(missionPath, 'mission-state.json');
  if (!safeExistsSync(statePath)) return undefined;
  try {
    const parsed = loadJson<{ status?: string }>(statePath);
    return typeof parsed.status === 'string' ? parsed.status : undefined;
  } catch {
    return undefined;
  }
}

function readMissionContext(missionId?: string): {
  tenantSlug?: string;
  projectId?: string;
  trackId?: string;
  trackName?: string;
} {
  if (!missionId) return {};
  const missionPath = findMissionPath(missionId.toUpperCase());
  if (!missionPath) return {};
  const statePath = path.join(missionPath, 'mission-state.json');
  if (!safeExistsSync(statePath)) return {};
  try {
    const state = loadJson<{
      tenant_slug?: string;
      tenant_id?: string;
      relationships?: {
        project?: { project_id?: string };
        track?: { track_id?: string; track_name?: string };
      };
    }>(statePath);
    return {
      tenantSlug: state.tenant_slug || state.tenant_id,
      projectId: state.relationships?.project?.project_id,
      trackId: state.relationships?.track?.track_id,
      trackName: state.relationships?.track?.track_name,
    };
  } catch {
    return {};
  }
}

function resolveArtifactRecordPath(artifactId: string): string {
  return pathResolver.shared(path.join('runtime', 'artifacts', `${artifactId}.json`));
}

/**
 * What makes two records "the same deliverable": the thing they point at. Falls
 * back to the artifact id so records without a path/ref are never merged.
 */
function deliverableIdentity(item: DeliverableInboxItem): string {
  return (item.path || item.externalRef || item.artifactId).toLowerCase();
}

/**
 * Keep the newest record per target and report how many it stood in for.
 * Input is expected to be sorted newest-first.
 */
export function dedupeDeliverables(items: DeliverableInboxItem[]): DeliverableInboxItem[] {
  const byIdentity = new Map<string, DeliverableInboxItem>();
  for (const item of items) {
    const identity = deliverableIdentity(item);
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, item);
      continue;
    }
    existing.supersededCount = (existing.supersededCount || 0) + 1;
  }
  return Array.from(byIdentity.values());
}

function collectSearchText(item: DeliverableInboxItem): string {
  return [
    item.artifactId,
    item.missionId,
    item.projectId,
    item.trackId,
    item.trackName,
    item.kind,
    item.path,
    item.externalRef,
    item.previewText,
    item.missionStatus,
    item.integratedSummary,
    ...(item.roleSections || []).flatMap((section) => [
      section.role,
      section.summary,
      ...section.evidence_refs,
    ]),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();
}

export function collectDeliverableInbox(input: DeliverableInboxQuery = {}): DeliverableInboxItem[] {
  const query = input.query?.trim().toLowerCase() || '';
  const missionId = input.missionId?.trim().toUpperCase() || '';
  const kind = input.kind?.trim().toLowerCase() || '';
  const tier = input.tier || '';
  const governedInbox = listInboxEntries({ limit: 200 });

  const filtered = listArtifactRecords()
    .map((record) => {
      const recordPath = resolveArtifactRecordPath(record.artifact_id);
      const stats = safeExistsSync(recordPath) ? safeStat(recordPath) : null;
      // Paths in artifact records mix absolute and repo-relative; the UI and
      // the asset route both speak repo-relative.
      const root = pathResolver.rootDir().replace(/\\/g, '/').replace(/\/$/, '');
      const normalizedPath = record.path
        ? record.path.replace(/\\/g, '/').startsWith(`${root}/`)
          ? record.path.replace(/\\/g, '/').slice(root.length + 1)
          : record.path.replace(/\\/g, '/')
        : undefined;
      // The DELIVERABLE file itself (not the record json): tmp sweeps and
      // mission archival routinely delete these — surface it honestly.
      const targetMissing = normalizedPath
        ? !safeExistsSync(path.join(root, normalizedPath))
        : false;
      const linkedInbox = governedInbox.find((entry) => {
        if (
          record.mission_id &&
          entry.mission_id?.toUpperCase() !== record.mission_id.toUpperCase()
        )
          return false;
        if (!normalizedPath) return Boolean(record.mission_id && entry.mission_id);
        return entry.artifact_paths.some((artifactPath) =>
          artifactPath.replace(/\\/g, '/').endsWith(normalizedPath)
        );
      });
      const missionContext = readMissionContext(record.mission_id);
      return {
        artifactId: record.artifact_id,
        missing: targetMissing,
        missionId: record.mission_id,
        tenantSlug: record.tenant_slug || missionContext.tenantSlug,
        organizationId: record.organization_id,
        projectId: record.project_id || missionContext.projectId,
        trackId: record.track_id || missionContext.trackId,
        trackName: record.track_name || missionContext.trackName,
        kind: record.kind,
        storageClass: record.storage_class,
        path: normalizedPath,
        externalRef: record.external_ref,
        previewText: record.preview_text,
        missionStatus: readMissionStatus(record.mission_id),
        updatedAt: (stats?.mtime || stats?.ctime || new Date()).toISOString(),
        sizeBytes: stats?.size,
        reviewVerdict: loadDeliverableReviewState(record.artifact_id)?.reviews.slice(-1)[0]
          ?.verdict,
        reviewComment: loadDeliverableReviewState(record.artifact_id)?.reviews.slice(-1)[0]
          ?.comment,
        reviewVersion:
          loadDeliverableReviewState(record.artifact_id)?.latest_review_sequence ||
          loadDeliverableReviewState(record.artifact_id)?.latest_version,
        reviewCurrentArtifactId: loadDeliverableReviewState(record.artifact_id)
          ?.current_artifact_id,
        roleSections: linkedInbox?.role_sections,
        integratedSummary: linkedInbox?.integrated_summary,
      } satisfies DeliverableInboxItem;
    })
    .filter((item) => (missionId ? item.missionId?.toUpperCase() === missionId : true))
    .filter((item) =>
      input.tenantSlugs && input.tenantSlugs !== 'all'
        ? Boolean(item.tenantSlug && input.tenantSlugs.includes(item.tenantSlug))
        : true
    )
    .filter((item) =>
      input.organizationIds && input.organizationIds !== 'all'
        ? Boolean(item.organizationId && input.organizationIds.includes(item.organizationId))
        : true
    )
    .filter((item) =>
      input.projectIds && input.projectIds !== 'all'
        ? Boolean(item.projectId && input.projectIds.includes(item.projectId))
        : true
    )
    .filter((item) => (kind ? item.kind.toLowerCase().includes(kind) : true))
    .filter((item) =>
      tier ? item.path?.includes(`/${tier}/`) || item.externalRef?.includes(tier) : true
    )
    .filter((item) => (query ? collectSearchText(item).includes(query) : true));

  // Dedupe BEFORE the limit — otherwise a handful of re-registered fixtures
  // eats the whole page and the real deliverables never reach the operator.
  return dedupeDeliverables(filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))).slice(
    0,
    Math.max(1, Math.min(200, Number(input.limit || 50)))
  );
}
