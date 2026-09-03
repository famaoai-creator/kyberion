import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { nowIso } from './foundation/time.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';
import type { ProjectOperationalState } from './project-operational-state-registry.js';

const MISSION_LINK_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/project-operational-mission-link.schema.json'
);
const TRACK_STATE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/project-operational-track-state.schema.json'
);

function missionLinkCatalog(filePath: string) {
  return defineCatalog({
    id: 'project-operational-mission-link',
    path: filePath,
    schema: MISSION_LINK_SCHEMA_PATH,
  });
}

function trackStateCatalog(filePath: string) {
  return defineCatalog({
    id: 'project-operational-track-state',
    path: filePath,
    schema: TRACK_STATE_SCHEMA_PATH,
  });
}

function normalizeSegment(value: string, fallback = 'shared'): string {
  return (
    String(value || '')
      .trim()
      .replace(/[\\/]+/g, '-')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback
  );
}

function projectStateWorkspaceDir(
  projectId: string,
  tier: ProjectOperationalState['tier'],
  tenantSlug?: string
): string {
  return pathResolver.projectWorkspaceDir(projectId, tier, tenantSlug || 'shared');
}

export function projectOperationalMissionLinkPath(
  projectId: string,
  tier: ProjectOperationalState['tier'],
  tenantSlug: string | undefined,
  missionId: string
): string {
  return assertSafeRepositoryPath(
    path.join(
      projectStateWorkspaceDir(projectId, tier, tenantSlug),
      'state',
      'missions',
      normalizeSegment(missionId),
      'mission-link.json'
    ),
    { allowMissingLeaf: true }
  );
}

export function projectOperationalTrackStatePath(
  projectId: string,
  tier: ProjectOperationalState['tier'],
  tenantSlug: string | undefined,
  trackId: string
): string {
  return assertSafeRepositoryPath(
    path.join(
      projectStateWorkspaceDir(projectId, tier, tenantSlug),
      'state',
      'tracks',
      normalizeSegment(trackId),
      'track-state.json'
    ),
    { allowMissingLeaf: true }
  );
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
  const filePath = projectOperationalMissionLinkPath(
    input.project_id,
    input.tier,
    input.tenant_slug,
    input.mission_id
  );
  const validated = missionLinkCatalog(filePath).validate(
    {
      ...input,
      updated_at: input.updated_at || nowIso(),
    },
    filePath
  );
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(filePath, JSON.stringify(validated, null, 2));
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
  const filePath = projectOperationalTrackStatePath(
    input.project_id,
    input.tier,
    input.tenant_slug,
    input.track_id
  );
  const validated = trackStateCatalog(filePath).validate(
    {
      ...input,
      tenant_slug: input.tenant_slug?.trim() || undefined,
      active_mission_ids: input.active_mission_ids || [],
      updated_at: input.updated_at || nowIso(),
    },
    filePath
  );
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(filePath, JSON.stringify(validated, null, 2));
  return filePath;
}
