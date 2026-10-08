import type { ProjectRecord } from './project-registry.js';
import { listProjectTracksForProject } from './project-track-registry.js';
import { ACTIVE_PROJECT_MISSION_STATUSES } from './project-mission-index.js';
import {
  isInProjectScope,
  isMissionInProjectScope,
  isTrackInProjectScope,
  isWorkerProjectContext,
  projectMissions,
  projectSessions,
} from './project-view-scope.js';

export const ACTIVE_TASK_SESSION_STATUSES = new Set([
  'awaiting_instruction',
  'collecting_requirements',
  'planning',
  'awaiting_confirmation',
  'executing',
  'verifying',
  'blocked',
  'paused',
]);
const ACTIVE_MISSION_STATUSES = ACTIVE_PROJECT_MISSION_STATUSES;

export function assertProjectCanArchive(project: ProjectRecord): void {
  const activeMissions = projectMissions(project.project_id).filter(
    (mission) =>
      isMissionInProjectScope(mission, project) && ACTIVE_MISSION_STATUSES.has(mission.status)
  );
  if (activeMissions.length)
    throw new Error(
      `Cannot archive project with active missions: ${activeMissions.map((mission) => mission.mission_id).join(', ')}`
    );
  const activeSessions = projectSessions(project.project_id).filter(
    (session) =>
      isInProjectScope(session, project) && ACTIVE_TASK_SESSION_STATUSES.has(session.status)
  );
  if (activeSessions.length)
    throw new Error(
      `Cannot archive project with active task sessions: ${activeSessions.map((session) => session.session_id).join(', ')}`
    );
  const activeTracks = listProjectTracksForProject(project.project_id).filter(
    (track) =>
      isTrackInProjectScope(track, project) &&
      ['planned', 'active', 'paused'].includes(track.status)
  );
  if (activeTracks.length)
    throw new Error(
      `Complete or archive project tracks first: ${activeTracks.map((track) => track.track_id).join(', ')}`
    );
}

export function assertProjectLifecycleOwner(): void {
  if (isWorkerProjectContext())
    throw new Error(
      'Project management mutations require the mission owner; workers cannot change project lifecycle or tracks.'
    );
}
