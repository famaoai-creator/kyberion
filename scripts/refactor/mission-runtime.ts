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
  loadOrganizationProfile,
  enrichMissionTeamPlanWithOrganizationProfile,
  resolveMissionTeamPlan,
  startAgentRuntimeSupervisorForRequest,
  writeMissionTeamPlan,
} from '@agent/core';
import { loadState } from './mission-state.js';

function emitTeamSummary(plan: {
  organization_profile?: { name: string; organization_id: string; default_team_template?: string; team_template_catalog_id?: string };
  template: string;
  assignments: Array<{ status: string; required: boolean; team_role: string }>;
}): void {
  const assignedRoles = plan.assignments.filter((assignment) => assignment.status === 'assigned').length;
  const requiredRoles = plan.assignments.filter((assignment) => assignment.required).length;
  const unfilledRequiredRoles = plan.assignments.filter((assignment) => assignment.required && assignment.status !== 'assigned').length;
  const organizationLabel = plan.organization_profile
    ? `${plan.organization_profile.name} (${plan.organization_profile.organization_id})`
    : 'default';
  const defaultTemplate = plan.organization_profile?.default_team_template || plan.template;
  const catalog = plan.organization_profile?.team_template_catalog_id || 'default';
  logger.info(
    `[team] org=${organizationLabel} template=${plan.template} default=${defaultTemplate} catalog=${catalog}`,
  );
  logger.info(
    `[team] assignments=${plan.assignments.length} required=${requiredRoles} assigned=${assignedRoles} unfilled_required=${unfilledRequiredRoles}`,
  );
}

function emitRuntimeSummary(plan: {
  organization_profile?: { name: string; organization_id: string; default_team_template?: string; team_template_catalog_id?: string };
  assignments: Array<{ runtime_status: string; team_role: string; agent_id?: string; error?: string }>;
}): void {
  const counts = {
    spawned: 0,
    already_ready: 0,
    unfilled: 0,
    failed: 0,
  };
  for (const assignment of plan.assignments) {
    if (assignment.runtime_status in counts) {
      counts[assignment.runtime_status as keyof typeof counts] += 1;
    }
  }
  const organizationLabel = plan.organization_profile
    ? `${plan.organization_profile.name} (${plan.organization_profile.organization_id})`
    : 'default';
  const defaultTemplate = plan.organization_profile?.default_team_template || 'n/a';
  const catalog = plan.organization_profile?.team_template_catalog_id || 'default';
  logger.info(
    `[staff] org=${organizationLabel} default=${defaultTemplate} catalog=${catalog} assignments=${plan.assignments.length}`,
  );
  logger.info(
    `[staff] spawned=${counts.spawned} already_ready=${counts.already_ready} unfilled=${counts.unfilled} failed=${counts.failed}`,
  );
}

export function showMissionTeam(id: string, refresh = false, rootDir?: string): void {
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

  const organizationProfile = loadOrganizationProfile(rootDir);
  let plan = refresh ? null : loadMissionTeamPlan(upperId);
  if (!plan) {
    plan = resolveMissionTeamPlan({
      missionId: upperId,
      missionType: state.mission_type || 'development',
      tier: state.tier,
      assignedPersona: state.assigned_persona,
      organizationProfile,
    });
    writeMissionTeamPlan(missionPath, plan);
    initializeMissionTeamBindings(missionPath, plan);
  } else if (organizationProfile) {
    const enriched = enrichMissionTeamPlanWithOrganizationProfile(plan, organizationProfile);
    if (enriched !== plan) {
      plan = enriched;
      writeMissionTeamPlan(missionPath, plan);
    }
  }

  emitTeamSummary(plan);

  console.log(JSON.stringify(plan, null, 2));
}

export async function staffMissionTeam(id: string, rootDir?: string): Promise<void> {
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

  const missionPath = findMissionPath(upperId);
  if (!missionPath) {
    logger.error(`Mission directory for ${upperId} not found.`);
    return;
  }

  const organizationProfile = loadOrganizationProfile(rootDir);
  let plan = loadMissionTeamPlan(upperId);
  if (!plan) {
    plan = resolveMissionTeamPlan({
      missionId: upperId,
      missionType: state.mission_type || 'development',
      tier: state.tier,
      assignedPersona: state.assigned_persona,
      organizationProfile,
    });
    writeMissionTeamPlan(missionPath, plan);
    initializeMissionTeamBindings(missionPath, plan);
  } else if (organizationProfile) {
    const enriched = enrichMissionTeamPlanWithOrganizationProfile(plan, organizationProfile);
    if (enriched !== plan) {
      plan = enriched;
      writeMissionTeamPlan(missionPath, plan);
    }
  }

  const runtimePlan = await ensureMissionTeamRuntimeViaSupervisor({
    missionId: upperId,
    requestedBy: 'mission_controller',
    reason: 'Explicit mission team staffing request.',
    timeoutMs: 600_000,
  });
  emitRuntimeSummary(runtimePlan.runtime_plan);
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
