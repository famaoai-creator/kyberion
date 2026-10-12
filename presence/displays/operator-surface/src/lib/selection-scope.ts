import { resolveScopeResolution } from '@agent/core/scope-context';
import { resolveMissionTeamSelectionScope } from '@agent/core/mission/mission-lifecycle-service';
import { loadState } from '@agent/core/mission/mission-state';
import type { MissionState } from '@agent/core/mission/mission-types';
import type { OperatorViewer } from './viewer-context';

export class SelectionAccessError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string
  ) {
    super(code);
  }
}

export function isSelectionAdmin(viewer: OperatorViewer): boolean {
  return (
    viewer.role === 'localadmin' &&
    viewer.source === 'token' &&
    viewer.credentialSource !== 'none' &&
    Boolean(viewer.principalId)
  );
}

/** Persisted scope and explicit server bindings are authoritative; never infer via Git/probes. */
function serverScope() {
  try {
    return resolveScopeResolution({}, process.env, { inferFromCwd: false });
  } catch {
    return null;
  }
}

export function isGlobalSelectionAdmin(viewer: OperatorViewer): boolean {
  const resolution = serverScope();
  if (!resolution) return false;
  const { scope, provenance } = resolution;
  const bound = Boolean(
    scope.tenant_slug ||
    scope.organization_id ||
    scope.project_id ||
    scope.mission_id ||
    scope.task_id ||
    scope.session_id ||
    (provenance.tier && provenance.tier !== 'default')
  );
  return (
    isSelectionAdmin(viewer) &&
    viewer.tenantSlugs === 'all' &&
    viewer.organizationIds === 'all' &&
    viewer.projectIds === 'all' &&
    viewer.tierAccess?.includes('public') &&
    viewer.tierAccess.includes('confidential') &&
    !bound
  );
}

function within(scope: string[] | 'all', value: string | undefined): boolean {
  return scope === 'all' || Boolean(value && scope?.includes(value));
}

/** Check actual state, never query/body scope. Missing scoped dimensions fail closed. */
export function canViewSelectionMission(viewer: OperatorViewer, state: MissionState): boolean {
  let scope;
  try {
    scope = resolveMissionTeamSelectionScope(state);
  } catch {
    return false;
  }
  const server = serverScope();
  if (!server) return false;
  for (const dimension of ['tenant_slug', 'organization_id', 'project_id'] as const) {
    if (server.scope[dimension] && scope[dimension] !== server.scope[dimension]) return false;
  }
  if (server.scope.mission_id && server.scope.mission_id !== state.mission_id) return false;
  if ((server.scope.task_id || server.scope.session_id) && !server.scope.mission_id) return false;
  if (
    server.provenance.tier &&
    server.provenance.tier !== 'default' &&
    server.scope.tier !== scope.tier
  )
    return false;
  return (
    Boolean(viewer.tierAccess?.includes(state.tier)) &&
    scope.tier !== 'personal' &&
    within(viewer.tenantSlugs, scope.tenant_slug) &&
    within(viewer.organizationIds, scope.organization_id) &&
    within(viewer.projectIds, scope.project_id)
  );
}

export function requireSelectionMission(viewer: OperatorViewer, id: string): MissionState {
  if (!/^MSN-[A-Z0-9][A-Z0-9_-]{0,127}$/.test(id))
    throw new SelectionAccessError(400, 'INVALID_MISSION_ID');
  const state = loadState(id);
  if (!state || state.mission_id !== id) throw new SelectionAccessError(404, 'MISSION_NOT_FOUND');
  if (!canViewSelectionMission(viewer, state))
    throw new SelectionAccessError(403, 'MISSION_SCOPE_DENIED');
  return state;
}
