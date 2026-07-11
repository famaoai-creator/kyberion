import path from 'node:path';
import { listArtifactRecords, type ArtifactRecord } from '@agent/core/artifact-record';
import { findMissionPath, pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile, safeStat } from '@agent/core/secure-io';
import { loadDeliverableReviewState } from './deliverable-review';

export interface DeliverableInboxItem {
  artifactId: string;
  /** True when the record points at a local file that no longer exists. */
  missing?: boolean;
  missionId?: string;
  projectId?: string;
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
}

export interface DeliverableInboxQuery {
  query?: string;
  missionId?: string;
  kind?: string;
  tier?: 'personal' | 'confidential' | 'public' | '';
  limit?: number;
}

function readMissionStatus(missionId?: string): string | undefined {
  if (!missionId) return undefined;
  const missionPath = findMissionPath(missionId.toUpperCase());
  if (!missionPath) return undefined;
  const statePath = path.join(missionPath, 'mission-state.json');
  if (!safeExistsSync(statePath)) return undefined;
  try {
    const parsed = JSON.parse(safeReadFile(statePath, { encoding: 'utf8' }) as string) as {
      status?: string;
    };
    return typeof parsed.status === 'string' ? parsed.status : undefined;
  } catch {
    return undefined;
  }
}

function resolveArtifactRecordPath(artifactId: string): string {
  return pathResolver.shared(path.join('runtime', 'artifacts', `${artifactId}.json`));
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

  return listArtifactRecords()
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
      return {
        artifactId: record.artifact_id,
        missing: targetMissing,
        missionId: record.mission_id,
        projectId: record.project_id,
        trackId: record.track_id,
        trackName: record.track_name,
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
      } satisfies DeliverableInboxItem;
    })
    .filter((item) => (missionId ? item.missionId?.toUpperCase() === missionId : true))
    .filter((item) => (kind ? item.kind.toLowerCase().includes(kind) : true))
    .filter((item) =>
      tier ? item.path?.includes(`/${tier}/`) || item.externalRef?.includes(tier) : true
    )
    .filter((item) => (query ? collectSearchText(item).includes(query) : true))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(1, Math.min(200, Number(input.limit || 50))));
}
