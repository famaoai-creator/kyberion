import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';
import type { ProjectOperationalState } from './project-operational-state-registry.js';

function normalizeSegment(value: string, fallback = 'shared'): string {
  return String(value || '')
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function projectStateWorkspaceDir(projectId: string, tier: ProjectOperationalState['tier'], tenantSlug?: string): string {
  return pathResolver.projectWorkspaceDir(projectId, tier, tenantSlug || 'shared');
}

export function projectOperationalMissionLinkPath(projectId: string, tier: ProjectOperationalState['tier'], tenantSlug: string | undefined, missionId: string): string {
  return path.join(projectStateWorkspaceDir(projectId, tier, tenantSlug), 'state', 'missions', normalizeSegment(missionId), 'mission-link.json');
}

export function projectOperationalTrackStatePath(projectId: string, tier: ProjectOperationalState['tier'], tenantSlug: string | undefined, trackId: string): string {
  return path.join(projectStateWorkspaceDir(projectId, tier, tenantSlug), 'state', 'tracks', normalizeSegment(trackId), 'track-state.json');
}

export function saveProjectMissionLink(input: {
  project_id: string;
  tier: ProjectOperationalState['tier'];
  mission_id: string;
  tenant_slug?: string;
  relationship_type: string;
  summary: string;
  status: string;
  evidence_refs?: string[];
  updated_at?: string;
}): string {
  const filePath = projectOperationalMissionLinkPath(input.project_id, input.tier, input.tenant_slug, input.mission_id);
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(filePath, JSON.stringify({
    ...input,
    updated_at: input.updated_at || new Date().toISOString(),
  }, null, 2));
  return filePath;
}

export function saveProjectTrackState(input: {
  project_id: string;
  tier: ProjectOperationalState['tier'];
  track_id: string;
  tenant_slug?: string;
  name: string;
  summary: string;
  status: string;
  lifecycle_model?: string;
  required_artifacts?: string[];
  active_mission_ids?: string[];
  updated_at?: string;
}): string {
  const filePath = projectOperationalTrackStatePath(input.project_id, input.tier, input.tenant_slug, input.track_id);
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(filePath, JSON.stringify({
    ...input,
    tenant_slug: input.tenant_slug?.trim() || undefined,
    active_mission_ids: input.active_mission_ids || [],
    updated_at: input.updated_at || new Date().toISOString(),
  }, null, 2));
  return filePath;
}
