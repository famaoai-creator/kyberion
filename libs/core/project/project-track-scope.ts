import type { ProjectRecord } from './project-registry.js';
import type { ProjectTrackRecord } from './project-track-registry.js';

export function assertManagedProjectTrackScope(
  project: Pick<ProjectRecord, 'project_id' | 'tier' | 'tenant_slug'>,
  track: ProjectTrackRecord
): void {
  const projectTenant = project.tenant_slug || 'shared';
  const trackTenant = track.tenant_slug || projectTenant;
  if (track.project_id !== project.project_id) {
    throw new Error(`Track ${track.track_id} does not belong to project ${project.project_id}`);
  }
  if (track.tier !== project.tier || (project.tier === 'confidential' && !track.tenant_slug)) {
    throw new Error(
      `Track ${track.track_id} scope (${track.tier}:${track.tenant_slug || 'unknown'}) must match project scope (${project.tier}:${projectTenant}).`
    );
  }
  if (trackTenant !== projectTenant) {
    throw new Error(
      `Track ${track.track_id} scope (${track.tier}:${track.tenant_slug || 'shared'}) must match project scope (${project.tier}:${projectTenant}).`
    );
  }
}

/** A stored work binding wins over the current conversational selection. */
export function selectScopedProjectTrack(input: {
  project?: Pick<ProjectRecord, 'project_id' | 'tier' | 'tenant_slug'>;
  boundTrackId?: string;
  selectedTrackId?: string;
  defaultTrackId?: string;
  suppliedTrack?: ProjectTrackRecord | null;
  load?: (trackId: string) => ProjectTrackRecord | null;
}): ProjectTrackRecord | null {
  const { project, boundTrackId, suppliedTrack } = input;
  const id =
    boundTrackId || input.selectedTrackId || suppliedTrack?.track_id || input.defaultTrackId;
  if (!project || !id) return null;
  const record = suppliedTrack?.track_id === id ? suppliedTrack : input.load?.(id);
  if (!record || record.track_id !== id || (!boundTrackId && record.status !== 'active'))
    return null;
  try {
    assertManagedProjectTrackScope(project, record);
    return record;
  } catch {
    return null;
  }
}
