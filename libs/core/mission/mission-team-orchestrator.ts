import { reserveMissionTeamSelectionDispatch } from './mission-team-selection.js';
import { resolveAgentLifecycleModelId } from '../agent/agent-lifecycle.js';
import { ensureAgentRuntime } from '../agent/agent-runtime-port.js';
import { ensureAgentRuntimeViaDaemon } from '../agent/agent-runtime-supervisor-client.js';
import { agentRegistry } from '../agent/agent-registry.js';
import {
  loadMissionTeamPlan,
  type MissionTeamAssignment,
  type MissionTeamOrganizationProfileSummary,
} from './mission-team-plan-composer.js';
import { staffMissionTeamRoles } from './mission-team-binding.js';
import type { EventScopeInput } from '../event-scope.js';

export interface MissionTeamRuntimeAssignment extends MissionTeamAssignment {
  runtime_status: 'spawned' | 'already_ready' | 'standby' | 'unfilled' | 'failed';
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
  /** Stable supervisor/process identity used by runtime ownership records. */
  runtimeOwnerId?: string;
  runtimeOwnerType?: string;
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
  const runtimeOwnerId = typeof input === 'string' ? undefined : input.runtimeOwnerId;
  const runtimeOwnerType = typeof input === 'string' ? undefined : input.runtimeOwnerType;
  const requestedRoles = teamRoles ? new Set(teamRoles) : null;

  const loadedPlan = loadMissionTeamPlan(missionId);
  if (!loadedPlan) {
    throw new Error(`Mission team plan not found for ${missionId}`);
  }

  // TC-02: a role-scoped ensure IS the staffing demand — the caller (task
  // dispatch, handoff) knows which roles the work needs. Promote those
  // standby roles through the governed entry point so the plan, the staffing
  // records and the execution ledger all move together. An unscoped ensure
  // only materializes what is already staffed; it must never staff the whole
  // roster, or demand-driven staffing would collapse back into eager
  // staffing.
  const plan =
    requestedRoles && requestedRoles.size > 0
      ? (staffMissionTeamRoles({
          missionId,
          teamRoles: [...requestedRoles],
          requestedBy: runtimeOwnerType || 'mission_team_orchestrator',
          reason: 'Role demanded by mission work dispatch.',
        }).plan ?? loadedPlan)
      : loadedPlan;

  const assignments: MissionTeamRuntimeAssignment[] = [];
  const resolvedRuntimeStatus = new Map<string, MissionTeamRuntimeAssignment>();

  for (const assignment of plan.assignments) {
    if (requestedRoles && !requestedRoles.has(assignment.team_role)) {
      continue;
    }

    if (assignment.status === 'standby') {
      assignments.push({
        ...assignment,
        runtime_status: 'standby',
      });
      continue;
    }

    if (assignment.status !== 'assigned' || !assignment.agent_id) {
      assignments.push({
        ...assignment,
        runtime_status: 'unfilled',
      });
      continue;
    }

    const runtimeKey = JSON.stringify([
      assignment.agent_id,
      assignment.provider,
      assignment.modelId,
      assignment.requested_selection,
      // Explicit contracts are role-owned even when two roles share the same actor.
      assignment.requested_selection ? assignment.team_role : undefined,
    ]);
    const cached = resolvedRuntimeStatus.get(runtimeKey);
    if (cached) {
      assignments.push({
        ...assignment,
        runtime_status: cached.runtime_status,
        error: cached.error,
      });
      continue;
    }

    if (assignment.requested_selection) {
      // Pure preflight precedes the durable reservation; failed routing never claims a launch.
      resolveAgentLifecycleModelId({
        modelId: assignment.modelId || undefined,
        runtimeMetadata: {
          requested_selection: assignment.requested_selection,
          task_model_hint: assignment.model_hint,
        },
      });
    }
    reserveMissionTeamSelectionDispatch({
      missionId,
      teamRole: assignment.team_role,
      agentId: assignment.agent_id,
      provider: assignment.provider || undefined,
      modelId: assignment.modelId || undefined,
      expectedRequestedSelection: assignment.requested_selection || null,
    });
    const wasReady = isReady(assignment.agent_id, assignment);
    // A ready record alone cannot prove explicit ownership/selection constraints.
    // Let lifecycle validate or safely adopt the contract even when no boot is needed.
    if (!assignment.requested_selection && wasReady) {
      const resolved = {
        ...assignment,
        runtime_status: 'already_ready',
      } satisfies MissionTeamRuntimeAssignment;
      resolvedRuntimeStatus.set(runtimeKey, resolved);
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
          requested_selection: assignment.requested_selection,
          selection_resolution: assignment.selection_resolution,
          required_capabilities: assignment.required_capabilities,
          ...(assignment.requested_selection
            ? {
                mission_id: missionId.toUpperCase(),
                team_role: assignment.team_role,
                execution_mode: 'task',
                // The prewarm supervisor requested this launch; the mission remains the
                // stable owner when a later A2A task acquires the same runtime.
                requested_runtime_owner_id: runtimeOwnerId,
                requested_runtime_owner_type: runtimeOwnerType,
              }
            : {}),
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
        ...(assignment.requested_selection
          ? { runtimeOwnerId: missionId.toUpperCase(), runtimeOwnerType: 'mission' }
          : {
              ...(runtimeOwnerId ? { runtimeOwnerId } : {}),
              ...(runtimeOwnerType ? { runtimeOwnerType } : {}),
            }),
      };
      try {
        await ensureAgentRuntimeViaDaemon(spawnPayload);
      } catch (_) {
        await ensureAgentRuntime(spawnPayload);
      }
      const resolved = {
        ...assignment,
        runtime_status: wasReady ? 'already_ready' : 'spawned',
      } satisfies MissionTeamRuntimeAssignment;
      resolvedRuntimeStatus.set(runtimeKey, resolved);
      assignments.push(resolved);
    } catch (error) {
      const resolved = {
        ...assignment,
        runtime_status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      } satisfies MissionTeamRuntimeAssignment;
      resolvedRuntimeStatus.set(runtimeKey, resolved);
      assignments.push(resolved);
    }
  }

  return {
    mission_id: plan.mission_id,
    organization_profile: plan.organization_profile,
    assignments,
  };
}
