import type { ProjectRecord } from './project-registry.js';
import type { ProjectTrackRecord } from './project-track-registry.js';

export function assertManagedProjectTrackScope(
  project: ProjectRecord,
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
