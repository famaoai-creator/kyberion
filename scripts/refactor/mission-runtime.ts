/**
 * scripts/refactor/mission-runtime.ts
 * Mission team and runtime control helpers.
 */

import {
  enqueueMissionTeamPrewarmRequest,
  ensureMissionTeamRuntimeViaSupervisor,
  findMissionPath,
  initializeMissionTeamBindings,
  loadMissionTeamPlan,
  logger,
  resolveMissionTeamPlan,
  startAgentRuntimeSupervisorForRequest,
  writeMissionTeamPlan,
} from '@agent/core';
import { loadState } from './mission-state.js';

export function showMissionTeam(id: string, refresh = false): void {
  if (!id) {
    logger.error('Usage: mission_controller team <MISSION_ID> [--refresh]');
    return;
  }

  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found. Run "list" to see available missions.`);
    return;
  }

  const missionPath = findMissionPath(upperId);
  if (!missionPath) {
    logger.error(`Mission directory for ${upperId} not found.`);
    return;
  }

  let plan = refresh ? null : loadMissionTeamPlan(upperId);
  if (!plan) {
    plan = resolveMissionTeamPlan({
      missionId: upperId,
      missionType: state.mission_type || 'development',
      tier: state.tier,
      assignedPersona: state.assigned_persona,
    });
    writeMissionTeamPlan(missionPath, plan);
    initializeMissionTeamBindings(missionPath, plan);
  }

  console.log(JSON.stringify(plan, null, 2));
}

export async function staffMissionTeam(id: string): Promise<void> {
  if (!id) {
    logger.error('Usage: mission_controller staff <MISSION_ID>');
    return;
  }

  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found. Run "list" to see available missions.`);
    return;
  }

  const runtimePlan = await ensureMissionTeamRuntimeViaSupervisor({
    missionId: upperId,
    requestedBy: 'mission_controller',
    reason: 'Explicit mission team staffing request.',
    timeoutMs: 600_000,
  });
  console.log(JSON.stringify(runtimePlan.runtime_plan, null, 2));
}

export async function prewarmMissionTeam(id: string, teamRolesArg?: string): Promise<void> {
  if (!id) {
    logger.error('Usage: mission_controller prewarm <MISSION_ID> [team_role_csv]');
    return;
  }

  const upperId = id.toUpperCase();
  const teamRoles = teamRolesArg
    ? teamRolesArg.split(',').map((entry) => entry.trim()).filter(Boolean)
    : undefined;
  const request = enqueueMissionTeamPrewarmRequest({
    missionId: upperId,
    teamRoles,
    requestedBy: 'mission_controller',
    reason: 'Explicit mission team prewarm request.',
  });
  startAgentRuntimeSupervisorForRequest(request);
  console.log(JSON.stringify({
    status: 'queued',
    request_id: request.request_id,
    mission_id: request.mission_id,
    team_roles: request.team_roles || [],
  }, null, 2));
}
