import { ensureAgentRuntime } from './agent-runtime-supervisor.js';
import { ensureAgentRuntimeViaDaemon } from './agent-runtime-supervisor-client.js';
import { agentRegistry } from './agent-registry.js';
import {
  loadMissionTeamPlan,
  type MissionTeamAssignment,
  type MissionTeamOrganizationProfileSummary,
} from './mission-team-plan-composer.js';
import type { EventScopeInput } from './event-scope.js';

export interface MissionTeamRuntimeAssignment extends MissionTeamAssignment {
  runtime_status: 'spawned' | 'already_ready' | 'unfilled' | 'failed';
  error?: string;
}

export interface MissionTeamRuntimePlan {
  mission_id: string;
  organization_profile?: MissionTeamOrganizationProfileSummary;
  assignments: MissionTeamRuntimeAssignment[];
}

export interface EnsureMissionTeamRuntimeOptions {
  missionId: string;
  teamRoles?: string[];
  scope?: EventScopeInput;
}

function isReady(
  agentId: string,
  expected?: Pick<MissionTeamRuntimeAssignment, 'provider' | 'modelId'>
): boolean {
  const record = agentRegistry.get(agentId);
  if (record?.status !== 'ready' && record?.status !== 'busy') return false;
  if (expected?.provider && record.provider !== expected.provider) return false;
  if (expected?.modelId && record.modelId !== expected.modelId) return false;
  return true;
}

export async function ensureMissionTeamRuntime(
  input: string | EnsureMissionTeamRuntimeOptions
): Promise<MissionTeamRuntimePlan> {
  const missionId = typeof input === 'string' ? input : input.missionId;
  const teamRoles = typeof input === 'string' ? undefined : input.teamRoles;
  const requestedScope = typeof input === 'string' ? undefined : input.scope;
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

    if (isReady(assignment.agent_id, assignment)) {
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
          task_model_hint: assignment.model_hint,
        },
        missionId: missionId.toUpperCase(),
        scope: requestedScope || {
          scope_kind: 'mission',
          tier: plan.tier as 'personal' | 'confidential' | 'public',
          mission_id: plan.mission_id,
          ...(plan.tenant_slug ? { tenant_slug: plan.tenant_slug } : {}),
          ...(plan.organization_profile?.organization_id
            ? { organization_id: plan.organization_profile.organization_id }
            : {}),
        },
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
    organization_profile: plan.organization_profile,
    assignments,
  };
}
