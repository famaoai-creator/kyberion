import { ensureAgentRuntime } from './agent-runtime-supervisor.js';
import { ensureAgentRuntimeViaDaemon } from './agent-runtime-supervisor-client.js';
import { agentRegistry } from './agent-registry.js';
import { loadMissionTeamPlan, type MissionTeamAssignment } from './mission-team-plan-composer.js';

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

    try {
      if (!assignment.provider) {
        throw new Error(`Mission team assignment missing provider: ${assignment.team_role}`);
      }
      const spawnPayload = {
        agentId: assignment.agent_id,
        provider: assignment.provider,
        modelId: assignment.modelId || undefined,
        capabilities: assignment.required_capabilities,
        runtimeMetadata: {
          skip_provider_resolution: true,
        },
        missionId: missionId.toUpperCase(),
        requestedBy: 'mission_team_orchestrator',
      };
      try {
        await ensureAgentRuntimeViaDaemon(spawnPayload);
      } catch (_) {
        await ensureAgentRuntime(spawnPayload);
      }
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
