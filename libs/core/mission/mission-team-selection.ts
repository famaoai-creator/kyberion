import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { peekProviderDiscovery, type ProviderInfo } from '../provider/provider-discovery.js';
import { agentRegistry } from '../agent/agent-registry.js';
import { runtimeSupervisor } from '../tool/runtime-supervisor.js';
import { readSupervisorEvents } from '../agent/agent-runtime-events.js';
import { withWorkItemInventorySnapshot, type WorkItem } from '../workforce/work-coordination.js';
import { collectWorkforceLoad } from '../workforce/workforce-load.js';
import { loadMissionStateAtPath } from './mission-state-reader.js';
import {
  loadAgentProfileIndex,
  loadAuthorityRoleIndex,
  loadTeamRoleIndex,
} from './mission-team-index.js';
import {
  getMissionTeamPlanPath,
  missionTeamPlanRevision,
  enrichAssignmentContext,
  loadMissionTeamPlanAtPath,
  loadMissionTeamPlan,
  resolveRoleSeparation,
  SEPARATION_ROLE_PAIRS,
  withMissionTeamPlanMutation,
  writeMissionTeamPlan,
  type MissionTeamPlan,
} from './mission-team-plan-composer.js';
import {
  normalizeMissionTeamRoleSelection,
  selectAgentForTeamRole,
  type MissionTeamAssignment,
  type MissionTeamRoleSelection,
  type MissionTeamSelectionResolution,
} from '../organization/team-role-assignment-selection.js';
import {
  appendMissionExecutionLedgerEntry,
  readMissionExecutionLedger,
  initializeMissionTeamBindings,
} from './mission-team-binding.js';
import type { MissionState } from './mission-types.js';

export type { MissionTeamRoleSelection } from '../organization/team-role-assignment-selection.js';

export interface MissionTeamSelectionScope {
  tier: string;
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
}

export interface PreviewMissionTeamSelectionInput {
  team_role?: string;
  selection?: MissionTeamRoleSelection;
  /** Server-resolved authorization scope. Never populate from an untrusted request body. */
  expected_scope?: MissionTeamSelectionScope;
}

export interface SaveMissionTeamSelectionInput extends PreviewMissionTeamSelectionInput {
  team_role: string;
  selection: MissionTeamRoleSelection;
  expected_revision: string;
  /** Binds the reviewed decision, not authorization. Recomputed under the save fence. */
  expected_preview_token: string;
}

export interface MissionTeamSelectionRoleView {
  team_role: string;
  configured: MissionTeamRoleSelection;
  effective: {
    agent_id: string | null;
    provider: string | null;
    model_id: string | null;
    status: MissionTeamAssignment['status'];
  };
  source: MissionTeamSelectionResolution['source'];
  reason: string;
  eligibility?: { eligible: boolean; reason: string };
  candidates: Array<{
    agent_id: string;
    provider: string | null;
    model_id: string | null;
    eligible: boolean;
    reason: string;
  }>;
}

export interface MissionTeamSelectionView {
  mission_id: string;
  revision: string;
  preview_token?: string;
  roles: MissionTeamSelectionRoleView[];
}

function selectionError(code: string, reason: string): never {
  throw new Error('[MISSION_TEAM_SELECTION_' + code + '] ' + reason);
}

/** Canonical aliases used by both surface authorization and the locked save assertion. */
export function resolveMissionTeamSelectionScope(
  state: Pick<MissionState, 'tier' | 'tenant_slug' | 'organization_id' | 'relationships'> & {
    project_id?: string;
  }
): MissionTeamSelectionScope {
  const dimension = (first: unknown, second: unknown, name: string): string | undefined => {
    const normalize = (value: unknown): string | undefined => {
      if (value === undefined || value === null || value === '') return undefined;
      if (typeof value !== 'string')
        return selectionError('INVALID', 'Invalid ' + name + ' scope.');
      return value.trim() || undefined;
    };
    const a = normalize(first),
      b = normalize(second);
    if (a && b && a !== b)
      return selectionError('INVALID', 'Conflicting ' + name + ' scope aliases.');
    return a || b;
  };
  return {
    tier: state.tier,
    tenant_slug: state.tenant_slug?.trim() || undefined,
    organization_id: dimension(
      state.organization_id,
      state.relationships?.organization?.organization_id,
      'organization'
    ),
    project_id: dimension(state.project_id, state.relationships?.project?.project_id, 'project'),
  };
}

// Reuse the existing strict governed team-plan lookup: hidden or ambiguous
// mission ownership must still throw rather than become an absent selection.
function missionSelectionDirectory(missionId: string): string | null {
  const planPath = getMissionTeamPlanPath(missionId);
  return planPath ? path.dirname(planPath) : null;
}

function readSelectionState(id: string, expected?: MissionTeamSelectionScope) {
  const missionId = id.trim().toUpperCase();
  const missionDir = missionSelectionDirectory(missionId);
  if (!missionDir) return selectionError('NOT_FOUND', 'Mission was not found.');
  const state = loadMissionStateAtPath(path.join(missionDir, 'mission-state.json'));
  if (!state || state.mission_id.toUpperCase() !== missionId) {
    return selectionError('NOT_FOUND', 'Canonical mission state was not found.');
  }
  const actual = resolveMissionTeamSelectionScope(state);
  if (
    expected &&
    (['tier', 'tenant_slug', 'organization_id', 'project_id'] as const).some(
      (key) => (expected[key] || undefined) !== (actual[key] || undefined)
    )
  ) {
    return selectionError('STALE', 'Mission authorization scope changed; reload before saving.');
  }
  const plan = loadMissionTeamPlanAtPath(path.join(missionDir, 'team-composition.json'), missionId);
  if (
    plan.tier !== state.tier ||
    (plan.tenant_slug || 'default') !== (state.tenant_slug || 'default')
  ) {
    return selectionError('INVALID', 'Mission team scope does not match canonical mission state.');
  }
  const providers = peekProviderDiscovery().providers;
  // Provider cache changes invalidate the preview rather than selecting a different target at save.
  const revision = createHash('sha256')
    .update(JSON.stringify({ state, plan, providers }))
    .digest('hex');
  return { missionId, missionDir, state, plan, providers, revision };
}

function selectRole(
  plan: MissionTeamPlan,
  assignment: MissionTeamAssignment,
  selection: MissionTeamRoleSelection,
  providers: ProviderInfo[]
): MissionTeamAssignment {
  const roleRecord = loadTeamRoleIndex()[assignment.team_role];
  if (!roleRecord) {
    const reason =
      'Unknown team role: ' +
      assignment.team_role +
      '; restore its catalog definition before changing or dispatching this role.';
    return {
      ...assignment,
      agent_id: null,
      provider: null,
      modelId: null,
      status: 'unfilled',
      requested_selection: selection,
      selection_resolution: { source: 'blocked', reason },
      notes: reason,
    };
  }
  const holders = new Map(
    plan.assignments
      .filter((entry) => entry.team_role !== assignment.team_role && entry.status !== 'unfilled')
      .map((entry) => [entry.team_role, { agentId: entry.agent_id, provider: entry.provider }])
  );
  const separation = resolveRoleSeparation(assignment.team_role, holders);
  // Editing the implementer after the reviewer is assigned must preserve the same hard pair.
  const reverseExclusions = SEPARATION_ROLE_PAIRS.filter(
    (pair) => pair.mustDifferFrom === assignment.team_role && pair.strength === 'hard'
  ).map((pair) => holders.get(pair.role)?.agentId);
  return selectAgentForTeamRole({
    teamRole: assignment.team_role,
    teamRoleRecord: roleRecord,
    authorityRoles: loadAuthorityRoleIndex(),
    agents: loadAgentProfileIndex(),
    organizationId: plan.organization_profile?.organization_id,
    tier: plan.tier,
    routingHint: assignment.model_hint,
    separation: {
      ...separation,
      excludeAgents: [...(separation?.excludeAgents || []), ...reverseExclusions],
    },
    requestedSelection: selection,
    discoveredProviders: providers,
    loadIndex: collectWorkforceLoad(),
  });
}

function missionTeamSelectionPreviewToken(
  snapshot: ReturnType<typeof readSelectionState>,
  teamRole: string,
  selection: MissionTeamRoleSelection,
  selected: MissionTeamAssignment
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        revision: snapshot.revision,
        team_role: teamRole,
        selection,
        decision: {
          agent_id: selected.agent_id,
          provider: selected.provider,
          model_id: selected.modelId,
          authority_role: selected.authority_role,
          delegation_contract: selected.delegation_contract,
          required_capabilities: selected.required_capabilities,
          status: selected.status,
        },
      })
    )
    .digest('hex');
}

function buildSelectionView(
  snapshot: ReturnType<typeof readSelectionState>,
  input: PreviewMissionTeamSelectionInput
): MissionTeamSelectionView {
  if (input.selection && !input.team_role)
    return selectionError('INVALID', 'A team role is required for a preview selection.');
  if (
    input.team_role &&
    !snapshot.plan.assignments.some((entry) => entry.team_role === input.team_role)
  ) {
    return selectionError('INVALID', 'Team role is not on this mission roster.');
  }
  const profiles = loadAgentProfileIndex();
  let previewToken: string | undefined;
  const roles = snapshot.plan.assignments
    .filter((assignment) => !input.team_role || assignment.team_role === input.team_role)
    .map((assignment): MissionTeamSelectionRoleView => {
      const requested = input.selection
        ? normalizeMissionTeamRoleSelection(input.selection)
        : snapshot.plan.selection_settings?.[assignment.team_role] ||
          assignment.requested_selection;
      const configured = requested || { mode: 'auto' as const };
      // GET and the save receipt describe the stored dispatch target. Only an
      // explicitly requested preview may resolve a different future target.
      const selected =
        input.selection && requested
          ? selectRole(snapshot.plan, assignment, requested, snapshot.providers)
          : assignment;
      if (input.selection && requested) {
        previewToken = missionTeamSelectionPreviewToken(
          snapshot,
          assignment.team_role,
          requested,
          selected
        );
      }
      const resolution = selected.selection_resolution || {
        source: 'legacy' as const,
        reason: 'Existing automatic selection; no mission role override is configured.',
      };
      const eligibility =
        selected.agent_id && selected.provider && selected.modelId
          ? selectRole(
              snapshot.plan,
              assignment,
              {
                mode: 'fixed',
                agent_id: selected.agent_id,
                provider: selected.provider,
                model_id: selected.modelId,
              },
              snapshot.providers
            )
          : null;
      return {
        team_role: assignment.team_role,
        configured,
        effective: {
          agent_id: selected.agent_id,
          provider: selected.provider,
          model_id: selected.modelId,
          status: input.selection
            ? selected.status === 'unfilled'
              ? 'unfilled'
              : assignment.status === 'assigned'
                ? 'assigned'
                : 'standby'
            : assignment.status,
        },
        source: resolution.source,
        reason:
          resolution.reason +
          (configured.mode === 'fixed'
            ? ' Fixed mission actor selection requires the agent_runtime execution surface; CLI-subagent dispatch is unsupported. Choose agent_runtime before dispatching this role.'
            : ''),
        eligibility: {
          eligible: Boolean(eligibility && eligibility.status !== 'unfilled'),
          reason:
            eligibility?.selection_resolution?.reason ||
            'The stored target is unavailable or no longer eligible.',
        },
        candidates: Object.entries(profiles)
          .filter(([, profile]) => profile.team_roles.includes(assignment.team_role))
          .map(([agentId]) => {
            const candidate = selectRole(
              snapshot.plan,
              assignment,
              {
                mode: 'fixed',
                agent_id: agentId,
                ...(configured.provider ? { provider: configured.provider } : {}),
                ...(configured.model_id ? { model_id: configured.model_id } : {}),
              },
              snapshot.providers
            );
            return {
              agent_id: agentId,
              provider: candidate.provider,
              model_id: candidate.modelId,
              eligible: candidate.status !== 'unfilled',
              reason: candidate.selection_resolution?.reason || candidate.notes,
            };
          }),
      };
    });
  return {
    mission_id: snapshot.missionId,
    revision: snapshot.revision,
    ...(previewToken ? { preview_token: previewToken } : {}),
    roles,
  };
}

/** Read-only, including cold-cache operation. Never probes or provisions a runtime. */
export function previewMissionTeamSelection(
  id: string,
  input: PreviewMissionTeamSelectionInput = {}
): MissionTeamSelectionView {
  return buildSelectionView(readSelectionState(id, input.expected_scope), input);
}

function assertRoleIdle(
  state: MissionState,
  plan: MissionTeamPlan,
  assignment: MissionTeamAssignment,
  inventory: readonly WorkItem[]
): void {
  const agentId = assignment.agent_id;
  const reservation = readMissionExecutionLedger(plan.mission_id)
    .filter(
      (entry) =>
        entry.team_role === assignment.team_role &&
        entry.event_type === 'team_selection_launch_reserved'
    )
    .at(-1);
  const reservedAgentId = reservation?.actor_id || agentId;
  const runtimeEvents = readSupervisorEvents();
  const sameMission = (event: Record<string, unknown>): boolean => {
    const scope = event.scope;
    return Boolean(
      scope &&
      typeof scope === 'object' &&
      'mission_id' in scope &&
      String(scope.mission_id).toUpperCase() === plan.mission_id.toUpperCase()
    );
  };
  const stop = reservedAgentId
    ? runtimeEvents
        .filter(
          (event) =>
            event.agent_id === reservedAgentId &&
            event.decision === 'agent_runtime_stopped' &&
            sameMission(event)
        )
        .at(-1)
    : undefined;
  const observedStart = reservation
    ? runtimeEvents
        .filter(
          (event) =>
            event.agent_id === reservedAgentId &&
            event.decision === 'agent_runtime_ensure_completed' &&
            sameMission(event) &&
            String(event.ts || '') >= reservation.ts &&
            (!stop || String(event.ts || '') < String(stop.ts || ''))
        )
        .at(-1)
    : undefined;
  const expectedGeneration =
    reservation?.payload?.runtime_generation ?? observedStart?.runtime_generation;
  if (
    reservation &&
    (!stop ||
      String(stop.ts || '') <= reservation.ts ||
      expectedGeneration === undefined ||
      stop.runtime_generation !== expectedGeneration)
  ) {
    return selectionError(
      'ACTIVE',
      'A launch reservation is active or its outcome is unknown; a later stop for the same runtime generation and mission is required before editing.'
    );
  }
  const local = agentId ? agentRegistry.get(agentId) : undefined;
  const runtime = agentId ? runtimeSupervisor.get(agentId) : undefined;
  if (
    (local && ['registered', 'booting', 'ready', 'busy'].includes(local.status)) ||
    runtime?.state === 'running'
  ) {
    return selectionError(
      'ACTIVE',
      'The role has an active runtime; stop it before changing selection.'
    );
  }
  const work = inventory.filter((item) => {
    if (
      state.tenant_slug &&
      item.context?.tenant_slug &&
      item.context.tenant_slug !== state.tenant_slug
    )
      return false;
    const itemMission = item.context?.mission_id || item.metadata?.mission_id || item.project_id;
    return (
      typeof itemMission === 'string' && itemMission.toUpperCase() === plan.mission_id.toUpperCase()
    );
  });
  if (
    work.some((item) => {
      const role =
        item.metadata?.team_role ||
        item.labels.find((label) => label.startsWith('team_role:'))?.slice(10);
      const owner = item.assignee_peer_id || item.metadata?.resolved_agent_id;
      const matches = role === assignment.team_role || (agentId && owner === agentId);
      return (
        matches &&
        (item.status === 'in_progress' ||
          Boolean(item.lease_id || item.claimed_by_peer_id || item.current_attempt_id))
      );
    })
  )
    return selectionError(
      'ACTIVE',
      'The role owns active or claimed work; release it before changing selection.'
    );

  // A daemon may own a runtime outside this process. Persisted ensure evidence is
  // conservative: only an observed stop proves the previously started actor idle.
  if (agentId) {
    const events = readSupervisorEvents().filter((event) => event.agent_id === agentId);
    const latest = events.at(-1);
    if (latest && latest.decision !== 'agent_runtime_stopped') {
      return selectionError(
        'ACTIVE',
        'Runtime activity has no confirmed stop; stop the actor before changing selection.'
      );
    }
  }
}

/** Called only by the governed lifecycle facade. No task ownership or runtime is changed. */
export function saveMissionTeamSelection(
  id: string,
  input: SaveMissionTeamSelectionInput
): MissionTeamSelectionView {
  const missionDir = missionSelectionDirectory(id.trim().toUpperCase());
  if (!missionDir) return selectionError('NOT_FOUND', 'Mission was not found.');
  return withMissionTeamPlanMutation(missionDir, () =>
    withWorkItemInventorySnapshot((inventory) => {
      const snapshot = readSelectionState(id, input.expected_scope);
      if (!input.expected_revision || input.expected_revision !== snapshot.revision) {
        return selectionError(
          'STALE',
          'The mission or provider cache changed; reload the selection preview.'
        );
      }
      const selection = normalizeMissionTeamRoleSelection(input.selection);
      const prior = snapshot.plan.assignments.find((entry) => entry.team_role === input.team_role);
      if (!prior) return selectionError('INVALID', 'Team role is not on this mission roster.');
      assertRoleIdle(snapshot.state, snapshot.plan, prior, inventory);
      const selected = selectRole(snapshot.plan, prior, selection, snapshot.providers);
      if (
        !input.expected_preview_token ||
        input.expected_preview_token !==
          missionTeamSelectionPreviewToken(snapshot, input.team_role, selection, selected)
      ) {
        return selectionError(
          'STALE',
          'The previewed actor or execution target changed; preview the selection again.'
        );
      }
      if (selected.status === 'unfilled') {
        return selectionError('INVALID', selected.selection_resolution?.reason || selected.notes);
      }
      const assignment = enrichAssignmentContext({
        assignment: {
          ...selected,
          required: prior.required,
          role_sources: prior.role_sources,
          model_hint: prior.model_hint,
        },
        missionId: snapshot.missionId,
        tier: snapshot.state.tier,
        tenantId: snapshot.state.tenant_slug || 'default',
        risk: snapshot.plan.mission_classification?.risk_profile || 'low',
      });
      assignment.status = prior.status === 'assigned' ? 'assigned' : 'standby';
      const assignments = snapshot.plan.assignments.map((entry) =>
        entry.team_role === input.team_role ? assignment : entry
      );
      const plan: MissionTeamPlan = {
        ...snapshot.plan,
        selection_settings: {
          ...snapshot.plan.selection_settings,
          [input.team_role]: selection,
        },
        assignments,
        ...(snapshot.plan.team_governance
          ? {
              team_governance: {
                ...snapshot.plan.team_governance,
                composition: {
                  ...snapshot.plan.team_governance.composition,
                  assigned_roles: assignments
                    .filter((entry) => entry.status === 'assigned')
                    .map((entry) => entry.team_role),
                  standby_roles: assignments
                    .filter((entry) => entry.status === 'standby')
                    .map((entry) => entry.team_role),
                  unfilled_required_roles: assignments
                    .filter((entry) => entry.required && entry.status === 'unfilled')
                    .map((entry) => entry.team_role),
                },
              },
            }
          : {}),
      };
      writeMissionTeamPlan(snapshot.missionDir, plan, {
        expectedRevision: missionTeamPlanRevision(snapshot.plan),
      });
      initializeMissionTeamBindings(snapshot.missionDir, plan);
      return buildSelectionView(readSelectionState(id, input.expected_scope), {});
    })
  );
}

/** Canonical read for dispatch preflight; absent legacy settings remain a no-op. */
export function readMissionTeamSelectionDispatch(input: {
  missionId: string;
  teamRole: string;
}): MissionTeamAssignment | null {
  const plan = loadMissionTeamPlan(input.missionId);
  const selection = plan?.selection_settings?.[input.teamRole];
  if (!selection) return null;
  const assignment = plan?.assignments.find((entry) => entry.team_role === input.teamRole);
  if (!assignment || assignment.status === 'unfilled' || !assignment.agent_id) {
    return selectionError('INVALID', 'Configured role has no eligible actor.');
  }
  if (
    selection.mode === 'fixed' &&
    ((selection.agent_id && selection.agent_id !== assignment.agent_id) ||
      (selection.provider && selection.provider !== assignment.provider) ||
      (selection.model_id && selection.model_id !== assignment.modelId))
  ) {
    return selectionError('INVALID', 'Effective assignment violates configured fixed dimensions.');
  }
  return { ...assignment, requested_selection: selection };
}

/**
 * Reserve an explicit-policy launch while holding the same fence as settings saves.
 * The durable reservation survives a controller crash. A confirmed supervisor stop
 * is required before selection can change again; a timeout is never proof of stop.
 * Call immediately before entering a runtime/claim boundary, after pure preflight.
 */
export function reserveMissionTeamSelectionDispatch(input: {
  executionRoute?: 'agent_runtime';
  missionId: string;
  teamRole: string;
  agentId: string;
  provider?: string;
  modelId?: string;
  expectedRequestedSelection?: MissionTeamRoleSelection | null;
}): MissionTeamAssignment | null {
  const initial = readMissionTeamSelectionDispatch(input);
  if (!initial && input.expectedRequestedSelection)
    return selectionError('STALE', 'Role policy changed before launch.');
  const missionDir = missionSelectionDirectory(input.missionId.toUpperCase());
  if (!missionDir) return null;
  return withMissionTeamPlanMutation(missionDir, () => {
    const currentPlan = loadMissionTeamPlan(input.missionId);
    const currentSelection = currentPlan?.selection_settings?.[input.teamRole];
    if (!currentSelection) {
      if (input.expectedRequestedSelection)
        return selectionError('STALE', 'Role policy changed before launch.');
      // Legacy routing remains unchanged. Its launch still reserves the role so
      // a simultaneous first settings save cannot replace an actor being started.
      if (currentPlan?.assignments.some((entry) => entry.team_role === input.teamRole)) {
        appendMissionExecutionLedgerEntry({
          mission_id: currentPlan.mission_id,
          mission_path_hint: missionDir,
          event_type: 'team_selection_launch_reserved',
          team_role: input.teamRole,
          actor_id: input.agentId,
          actor_type: 'agent',
          decision: 'Reserve existing actor before runtime dispatch.',
          payload: {
            requested_selection: null,
            runtime_generation: agentRegistry.get(input.agentId)?.spawnedAt,
          },
        });
      }
      return null;
    }
    const snapshot = readSelectionState(input.missionId);
    const requested = snapshot.plan.selection_settings?.[input.teamRole];
    if (
      input.expectedRequestedSelection !== undefined &&
      JSON.stringify(requested ? normalizeMissionTeamRoleSelection(requested) : null) !==
        JSON.stringify(
          input.expectedRequestedSelection
            ? normalizeMissionTeamRoleSelection(input.expectedRequestedSelection)
            : null
        )
    ) {
      return selectionError('STALE', 'Role policy changed before launch; repeat preflight.');
    }
    if (!requested) return null;
    if (requested.execution_route === 'agent_runtime' && input.executionRoute !== 'agent_runtime')
      return selectionError('INVALID', 'This role requires an agent_runtime launch reservation.');
    const assignment = snapshot.plan.assignments.find(
      (entry) => entry.team_role === input.teamRole
    );
    if (!assignment || assignment.status === 'unfilled' || !assignment.agent_id) {
      return selectionError('INVALID', 'Configured role has no eligible actor.');
    }
    if (
      assignment.agent_id !== input.agentId ||
      (input.provider && assignment.provider !== input.provider) ||
      (input.modelId && assignment.modelId !== input.modelId)
    ) {
      return selectionError(
        'STALE',
        'The role selection changed before launch; resolve the role again.'
      );
    }
    const validated = selectRole(
      snapshot.plan,
      assignment,
      {
        ...requested,
        mode: 'fixed',
        agent_id: assignment.agent_id,
        provider: assignment.provider || undefined,
        model_id: assignment.modelId || undefined,
      },
      snapshot.providers
    );
    if (validated.status === 'unfilled') {
      return selectionError('INVALID', validated.selection_resolution?.reason || validated.notes);
    }
    const prior = readMissionExecutionLedger(snapshot.missionId, snapshot.missionDir)
      .filter(
        (entry) =>
          entry.team_role === input.teamRole &&
          entry.event_type === 'team_selection_launch_reserved'
      )
      .at(-1);
    // Repeated ensure calls do not multiply reservations for an unchanged assignment.
    const stopped = readSupervisorEvents()
      .filter(
        (event) =>
          event.agent_id === assignment.agent_id && event.decision === 'agent_runtime_stopped'
      )
      .at(-1);
    if (
      !prior ||
      prior.actor_id !== assignment.agent_id ||
      prior.payload?.selection_revision !== snapshot.revision ||
      (stopped && String(stopped.ts || '') >= prior.ts)
    ) {
      appendMissionExecutionLedgerEntry({
        mission_id: snapshot.missionId,
        mission_path_hint: snapshot.missionDir,
        event_type: 'team_selection_launch_reserved',
        team_role: input.teamRole,
        actor_id: assignment.agent_id,
        actor_type: 'agent',
        decision: 'Reserve configured actor before runtime dispatch.',
        payload: {
          selection_revision: snapshot.revision,
          requested_selection: requested,
          runtime_generation: agentRegistry.get(input.agentId)?.spawnedAt,
        },
      });
    }
    return { ...assignment, requested_selection: requested };
  });
}
