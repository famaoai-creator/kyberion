import { agentLifecycle } from './agent-lifecycle.js';
import { agentRegistry } from './agent-registry.js';
import { loadAgentProfileIndex, loadMissionTeamPlan, type MissionTeamAssignment } from './mission-team-composer.js';

export interface MissionTeamRuntimeAssignment extends MissionTeamAssignment {
  runtime_status: 'spawned' | 'already_ready' | 'unfilled' | 'failed';
  error?: string;
}

export interface MissionTeamRuntimePlan {
  mission_id: string;
  assignments: MissionTeamRuntimeAssignment[];
}

export interface EnsureMissionTeamRuntimeOptions {
  missionId: string;
  teamRoles?: string[];
}

function isReady(agentId: string): boolean {
  const record = agentRegistry.get(agentId);
  return record?.status === 'ready' || record?.status === 'busy';
}

export async function ensureMissionTeamRuntime(input: string | EnsureMissionTeamRuntimeOptions): Promise<MissionTeamRuntimePlan> {
  const missionId = typeof input === 'string' ? input : input.missionId;
  const teamRoles = typeof input === 'string' ? undefined : input.teamRoles;
  const requestedRoles = teamRoles ? new Set(teamRoles) : null;

  const plan = loadMissionTeamPlan(missionId);
  if (!plan) {
    throw new Error(`Mission team plan not found for ${missionId}`);
  }

  const profiles = loadAgentProfileIndex();
  const assignments: MissionTeamRuntimeAssignment[] = [];
  const resolvedRuntimeStatus = new Map<string, MissionTeamRuntimeAssignment>();

  for (const assignment of plan.assignments) {
    if (requestedRoles && !requestedRoles.has(assignment.team_role)) {
      continue;
    }

    if (assignment.status !== 'assigned' || !assignment.agent_id) {
      assignments.push({
        ...assignment,
        runtime_status: 'unfilled',
      });
      continue;
    }

    const cached = resolvedRuntimeStatus.get(assignment.agent_id);
    if (cached) {
      assignments.push({
        ...assignment,
        runtime_status: cached.runtime_status,
        error: cached.error,
      });
      continue;
    }

    if (isReady(assignment.agent_id)) {
      const resolved = {
        ...assignment,
        runtime_status: 'already_ready',
      } satisfies MissionTeamRuntimeAssignment;
      resolvedRuntimeStatus.set(assignment.agent_id, resolved);
      assignments.push(resolved);
      continue;
    }

    const profile = profiles[assignment.agent_id];
    if (!profile) {
      const resolved = {
        ...assignment,
        runtime_status: 'failed',
        error: `Agent profile not found: ${assignment.agent_id}`,
      } satisfies MissionTeamRuntimeAssignment;
      resolvedRuntimeStatus.set(assignment.agent_id, resolved);
      assignments.push(resolved);
      continue;
    }

    try {
      await agentLifecycle.spawn({
        agentId: assignment.agent_id,
        provider: profile.provider,
        modelId: profile.modelId,
        capabilities: profile.capabilities,
        missionId: missionId.toUpperCase(),
      });
      const resolved = {
        ...assignment,
        runtime_status: 'spawned',
      } satisfies MissionTeamRuntimeAssignment;
      resolvedRuntimeStatus.set(assignment.agent_id, resolved);
      assignments.push(resolved);
    } catch (error) {
      const resolved = {
        ...assignment,
        runtime_status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      } satisfies MissionTeamRuntimeAssignment;
      resolvedRuntimeStatus.set(assignment.agent_id, resolved);
      assignments.push(resolved);
    }
  }

  return {
    mission_id: plan.mission_id,
    assignments,
  };
}
