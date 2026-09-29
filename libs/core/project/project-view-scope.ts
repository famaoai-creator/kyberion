import * as path from 'node:path';
import { getRegisteredEnvText } from '../foundation/env.js';
import { scopedPersona } from '../foundation/execution-scope.js';
import { resolveProjectScope } from '../foundation/project-scope-env.js';
import { listMissionsInSearchDirs, loadState, loadStateAtPath } from '../mission/mission-state.js';
import type { MissionState } from '../mission/mission-types.js';
import { pathResolver } from '../path-resolver.js';
import { listTaskSessions, type TaskSession } from '../task/task-session.js';
import type { ProjectOperationalState } from './project-operational-state-registry.js';
import { loadProjectRecord, type ProjectRecord } from './project-registry.js';
import type { ProjectTrackRecord } from './project-track-registry.js';

function kyberionEnv(name: string): string | undefined {
  return getRegisteredEnvText(name);
}

export function isWorkerProjectContext(): boolean {
  const executionPersona = scopedPersona();
  if (executionPersona.bound) return executionPersona.persona === 'worker';
  return kyberionEnv('KYBERION_PERSONA') === 'worker' || kyberionEnv('MISSION_ROLE') === 'worker';
}

export function assertWorkerProjectScope(projectId: string, project?: ProjectRecord): void {
  if (!isWorkerProjectContext()) return;
  const scope = resolveProjectScope();
  const scopedProjectId = scope.projectId;
  if (!scopedProjectId) {
    throw new Error('[PROJECT_SCOPE_MISSING] worker access requires KYBERION_PROJECT_ID.');
  }
  if (scopedProjectId !== projectId) {
    throw new Error(
      `[PROJECT_SCOPE_VIOLATION] worker project '${scopedProjectId}' cannot access '${projectId}'.`
    );
  }
  if (project?.tier === 'confidential') {
    const tenantSlug = scope.tenantSlug;
    if (!tenantSlug || tenantSlug !== project.tenant_slug) {
      throw new Error(
        `[PROJECT_SCOPE_VIOLATION] worker tenant '${tenantSlug || '(missing)'}' cannot access project tenant '${project.tenant_slug || '(missing)'}'.`
      );
    }
  }
  if (project?.tier === 'personal') {
    throw new Error(
      `[PROJECT_SCOPE_VIOLATION] worker access to personal project '${project.project_id}' is denied.`
    );
  }
}

export function workerProjectScopeId(): string | undefined {
  return resolveProjectScope().projectId;
}

export function projectMissions(
  projectId: string,
  rootDir = pathResolver.rootDir()
): MissionState[] {
  const project = loadProjectRecord(projectId, { rootDir });
  if (project && isWorkerProjectContext()) {
    const missionId = resolveProjectScope().missionId;
    if (!missionId) return [];
    const missionPath =
      rootDir === pathResolver.rootDir()
        ? pathResolver.missionDir(missionId, project.tier, project.tenant_slug)
        : path.join(
            rootDir,
            project.tier === 'personal' ? 'knowledge/personal/missions' : 'active/missions',
            ...(project.tier === 'personal'
              ? [missionId]
              : project.tenant_slug
                ? [project.tier, project.tenant_slug, missionId]
                : [project.tier, missionId])
          );
    const mission = loadStateAtPath(path.join(missionPath, 'mission-state.json'));
    return mission?.relationships?.project?.project_id === projectId ? [mission] : [];
  }
  const missionDirectories = project
    ? [
        project.tier === 'personal'
          ? path.join(rootDir, 'knowledge/personal/missions')
          : project.tier === 'confidential'
            ? path.join(rootDir, 'active/missions/confidential')
            : path.join(rootDir, 'active/missions/public'),
      ]
    : undefined;
  const missionOptions = {
    rootDir,
    ...(missionDirectories ? { directories: missionDirectories } : {}),
  };
  return listMissionsInSearchDirs(missionOptions)
    .map(({ missionId }) => loadState(missionId, missionOptions))
    .filter((state): state is MissionState => Boolean(state))
    .filter((state) => state.relationships?.project?.project_id === projectId);
}

export function projectSessions(
  projectId: string,
  rootDir = pathResolver.rootDir()
): TaskSession[] {
  return listTaskSessions(undefined, { rootDir }).filter(
    (session) => session.project_context?.project_id === projectId
  );
}

export function projectSessionScope(
  session: TaskSession,
  project: ProjectRecord
): { tier: ProjectRecord['tier']; tenant?: string } {
  const tier = session.project_context?.tier || project.tier;
  const tenant =
    session.project_context?.tenant_slug ||
    (tier === 'confidential' ? undefined : project.tenant_slug || 'shared');
  return { tier, tenant };
}

export function projectMissionScope(mission: MissionState): {
  tier: ProjectRecord['tier'];
  tenant?: string;
} {
  const tier = mission.tier;
  const tenant =
    mission.tenant_slug || mission.tenant_id || (tier === 'confidential' ? undefined : 'shared');
  return { tier, tenant };
}

export function isMissionInProjectScope(mission: MissionState, project: ProjectRecord): boolean {
  const scope = projectMissionScope(mission);
  return scope.tier === project.tier && scope.tenant === (project.tenant_slug || 'shared');
}

export function isTrackInProjectScope(track: ProjectTrackRecord, project: ProjectRecord): boolean {
  if (track.project_id !== project.project_id || track.tier !== project.tier) return false;
  if (project.tier === 'confidential' && !track.tenant_slug) return false;
  return (
    (track.tenant_slug || project.tenant_slug || 'shared') === (project.tenant_slug || 'shared')
  );
}

export function isOperationalStateInProjectScope(
  state: ProjectOperationalState,
  project: ProjectRecord
): boolean {
  return (
    state.project_id === project.project_id &&
    state.tier === project.tier &&
    (state.tenant_slug || 'shared') === (project.tenant_slug || 'shared')
  );
}

export function isInProjectScope(session: TaskSession, project: ProjectRecord): boolean {
  const scope = projectSessionScope(session, project);
  return scope.tier === project.tier && scope.tenant === (project.tenant_slug || 'shared');
}
