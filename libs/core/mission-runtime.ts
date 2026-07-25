/**
 * scripts/refactor/mission-runtime.ts
 * Mission team and runtime control helpers.
 */

import {
  enqueueMissionTeamPrewarmRequest,
  ensureMissionTeamRuntimeViaSupervisor,
  startAgentRuntimeSupervisorForRequest,
} from './agent-runtime-supervisor.js';
import { findMissionPath } from './path-resolver.js';
import { initializeMissionTeamBindings } from './mission-team-binding.js';
import {
  loadMissionTeamPlan,
  enrichMissionTeamPlanWithOrganizationProfile,
  resolveMissionTeamPlan,
  writeMissionTeamPlan,
} from './mission-team-plan-composer.js';
import { logger } from './core.js';
import { loadOrganizationProfile } from './organization-profile.js';
import { loadState } from './mission-state.js';

function emitTeamSummary(plan: {
  organization_profile?: {
    name: string;
    organization_id: string;
    default_team_template?: string;
    team_template_catalog_id?: string;
  };
  template: string;
  assignments: Array<{ status: string; required: boolean; team_role: string }>;
}): void {
  const assignedRoles = plan.assignments.filter(
    (assignment) => assignment.status === 'assigned'
  ).length;
  const requiredRoles = plan.assignments.filter((assignment) => assignment.required).length;
  const unfilledRequiredRoles = plan.assignments.filter(
    (assignment) => assignment.required && assignment.status !== 'assigned'
  ).length;
  const organizationLabel = plan.organization_profile
    ? `${plan.organization_profile.name} (${plan.organization_profile.organization_id})`
    : 'default';
  const defaultTemplate = plan.organization_profile?.default_team_template || plan.template;
  const catalog = plan.organization_profile?.team_template_catalog_id || 'default';
  logger.info(
    `[team] org=${organizationLabel} template=${plan.template} default=${defaultTemplate} catalog=${catalog}`
  );
  logger.info(
    `[team] assignments=${plan.assignments.length} required=${requiredRoles} assigned=${assignedRoles} unfilled_required=${unfilledRequiredRoles}`
  );
}

function emitRuntimeSummary(plan: {
  organization_profile?: {
    name: string;
    organization_id: string;
    default_team_template?: string;
    team_template_catalog_id?: string;
  };
  assignments: Array<{
    runtime_status: string;
    team_role: string;
    agent_id?: string | null;
    error?: string;
  }>;
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
    `[staff] org=${organizationLabel} default=${defaultTemplate} catalog=${catalog} assignments=${plan.assignments.length}`
  );
  logger.info(
    `[staff] spawned=${counts.spawned} already_ready=${counts.already_ready} unfilled=${counts.unfilled} failed=${counts.failed}`
  );
}

export function showMissionTeam(
  id: string,
  refresh = false,
  rootDir?: string
): ReturnType<typeof resolveMissionTeamPlan> | undefined {
  if (!id) {
    logger.error('Usage: mission_controller team <MISSION_ID> [--refresh]');
    return undefined;
  }

  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found. Run "list" to see available missions.`);
    return undefined;
  }

  const missionPath = findMissionPath(upperId);
  if (!missionPath) {
    logger.error(`Mission directory for ${upperId} not found.`);
    return undefined;
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

  // SO-01: return the plan instead of printing directly — printing is the
  // CLI router's job (scripts/mission_controller.ts), so in-process callers
  // (facade / other surfaces) can consume the value without stdout leakage.
  return plan;
}

export async function staffMissionTeam(
  id: string,
  rootDir?: string
): Promise<
  Awaited<ReturnType<typeof ensureMissionTeamRuntimeViaSupervisor>>['runtime_plan'] | undefined
> {
  if (!id) {
    logger.error('Usage: mission_controller staff <MISSION_ID>');
    return undefined;
  }

  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found. Run "list" to see available missions.`);
    return undefined;
  }

  const missionPath = findMissionPath(upperId);
  if (!missionPath) {
    logger.error(`Mission directory for ${upperId} not found.`);
    return undefined;
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
  // SO-01: return instead of printing — see showMissionTeam for rationale.
  return runtimePlan.runtime_plan;
}

export interface MissionTeamPrewarmSummary {
  status: 'queued';
  request_id: string;
  mission_id: string;
  team_roles: string[];
}

export async function prewarmMissionTeam(
  id: string,
  teamRolesArg?: string
): Promise<MissionTeamPrewarmSummary | undefined> {
  if (!id) {
    logger.error('Usage: mission_controller prewarm <MISSION_ID> [team_role_csv]');
    return undefined;
  }

  const upperId = id.toUpperCase();
  const teamRoles = teamRolesArg
    ? teamRolesArg
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : undefined;
  const request = enqueueMissionTeamPrewarmRequest({
    missionId: upperId,
    teamRoles,
    requestedBy: 'mission_controller',
    reason: 'Explicit mission team prewarm request.',
  });
  startAgentRuntimeSupervisorForRequest(request);
  // SO-01: return instead of printing — see showMissionTeam for rationale.
  return {
    status: 'queued',
    request_id: request.request_id,
    mission_id: request.mission_id,
    team_roles: request.team_roles || [],
  };
}
