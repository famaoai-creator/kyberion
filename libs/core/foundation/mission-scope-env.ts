import path from 'node:path';
import { rawExistsSync, rawReadTextFile } from '../fs-primitives.js';
import { pathResolver } from '../path-resolver.js';
import { isValidTenantSlug } from './scope.js';
import { KNOWLEDGE_TIERS, type TierLevel } from './knowledge-tier.js';

export interface MissionScopeBinding {
  tier?: TierLevel;
  tenantSlug?: string;
  organizationId?: string;
  projectId?: string;
}

/**
 * Read-only resolution of the scope a mission records in its own
 * mission-state.json (tier / tenant / organization / project). Environment and
 * persisted scope do not carry organization_id, so metering that wants an
 * honest org label must read the mission record — the same file the governed
 * facades write. Resolution never fabricates scope: an unresolvable or
 * tenant-invisible mission yields `undefined`, not a guess.
 *
 * Foundation-level sibling of project-scope-env.ts: raw fs reads only, no
 * secure-io dependency, so it can run inside metering paths reached during
 * secure-io authorization.
 */
const missionScopeCache = new Map<string, MissionScopeBinding | null>();
const MISSION_SCOPE_CACHE_MAX = 256;

export function resolveMissionScope(missionId: string): MissionScopeBinding | undefined {
  const key = String(missionId || '')
    .trim()
    .toUpperCase();
  if (!key) return undefined;
  if (missionScopeCache.has(key)) return missionScopeCache.get(key) ?? undefined;
  const binding = readMissionScopeBinding(key);
  if (missionScopeCache.size >= MISSION_SCOPE_CACHE_MAX) missionScopeCache.clear();
  missionScopeCache.set(key, binding ?? null);
  return binding;
}

/** Test seam: mission state can change between test fixtures. */
export function resetMissionScopeCacheForTests(): void {
  missionScopeCache.clear();
}

function readMissionScopeBinding(missionId: string): MissionScopeBinding | undefined {
  try {
    // findMissionPath resolves via the registered locator first and may throw
    // OWNER_NOT_VISIBLE / OWNER_AMBIGUOUS for missions outside this process's
    // scope — both mean "not attributable here", never an exception upward.
    const dir = pathResolver.findMissionPath(missionId);
    if (!dir) return undefined;
    const statePath = path.join(dir, 'mission-state.json');
    if (!rawExistsSync(statePath)) return undefined;
    const raw: unknown = JSON.parse(rawReadTextFile(statePath));
    if (!raw || typeof raw !== 'object') return undefined;
    const state = raw as Record<string, unknown>;
    const relationships =
      state.relationships && typeof state.relationships === 'object'
        ? (state.relationships as Record<string, unknown>)
        : undefined;
    const project =
      relationships?.project && typeof relationships.project === 'object'
        ? (relationships.project as Record<string, unknown>)
        : undefined;
    return {
      tier:
        typeof state.tier === 'string' &&
        (KNOWLEDGE_TIERS as readonly string[]).includes(state.tier)
          ? (state.tier as TierLevel)
          : undefined,
      tenantSlug:
        typeof state.tenant_slug === 'string' && isValidTenantSlug(state.tenant_slug)
          ? state.tenant_slug
          : undefined,
      organizationId:
        typeof state.organization_id === 'string' && state.organization_id.trim()
          ? state.organization_id.trim()
          : undefined,
      projectId:
        typeof project?.project_id === 'string' && project.project_id.trim()
          ? project.project_id.trim()
          : undefined,
    };
  } catch {
    return undefined;
  }
}
