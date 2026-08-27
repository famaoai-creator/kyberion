import { appendJsonLine, readJson } from './foundation/json.js';
import * as path from 'node:path';
import { assertMissionIdArgument, findMissionPath, missionDir } from './path-resolver.js';
import { deriveAgentNhiId, ensureAgentIdentityBestEffort, parseNhiId } from './agent-identity.js';
import { parseDelegationChain, type DelegationChain } from './delegation-chain.js';
import type { MissionTeamAssignment, MissionTeamPlan } from './mission-team-plan-composer.js';
import { safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';
import type {
  MissionTeamGovernance,
  MissionTeamOrganizationProfileSummary,
} from './mission-team-plan-composer.js';
import {
  normalizeEventScope,
  resolveEventScopeAgainstAuthority,
  type EventScope,
  type EventScopeInput,
} from './event-scope.js';

export interface TeamBlueprintRole {
  team_role: string;
  required: boolean;
  ownership_scope: string;
  allowed_delegate_team_roles: string[];
  escalation_parent_team_role: string | null;
  required_scope_classes: string[];
}

export interface MissionTeamBlueprint {
  version: '1.0.0';
  mission_id: string;
  mission_type: string;
  generated_at: string;
  source_artifact: string;
  organization_profile?: MissionTeamOrganizationProfileSummary;
  team_governance?: MissionTeamGovernance;
  roles: TeamBlueprintRole[];
}

export type MissionActorType = 'agent' | 'human' | 'service';

export interface WorkforceResourceRef {
  resource_id: string;
  resource_type: MissionActorType;
  display_name: string;
  authority_roles: string[];
  capabilities: string[];
  availability: Record<string, unknown>;
  cost_profile: Record<string, unknown>;
  status: 'active' | 'suspended' | 'revoked';
  accountable_human_id: string | null;
  provider?: string | null;
  model_id?: string | null;
  runtime_identity?: string | null;
}

export interface MissionStaffingAssignment {
  assignment_id: string;
  mission_id: string;
  team_role: string;
  actor_id: string;
  actor_type: MissionActorType;
  authority_role: string | null;
  provider: string | null;
  model_id: string | null;
  assigned_at: string;
  released_at: string | null;
  status: 'active' | 'released';
  source: 'team_composition';
  organization_role_id?: string;
  perspective_ids?: string[];
  reasoning_route_id?: string;
  security_scope?: import('./context-security-scope.js').ContextSecurityScope;
  selection_reason_codes?: string[];
  /** Delegation contract carried over from the team plan so staffing records are self-describing for audits. */
  delegation_contract?: MissionTeamAssignment['delegation_contract'];
  /** Actor-neutral resource contract. Legacy agent_id fields remain for readers during migration. */
  resource: WorkforceResourceRef;
}

export interface MissionStaffingAssignments {
  version: '1.0.0';
  mission_id: string;
  generated_at: string;
  organization_profile?: MissionTeamOrganizationProfileSummary;
  assignments: MissionStaffingAssignment[];
}

export interface MissionExecutionLedgerEntry {
  ts: string;
  mission_id: string;
  event_type: string;
  task_id?: string;
  team_role?: string;
  actor_id?: string;
  actor_type?: MissionActorType;
  /** NI-01: durable identity (nhi_id) of the acting resource, when known. */
  runtime_identity?: string;
  /**
   * NI-03: root-first delegation chain (who delegated this work to whom —
   * see delegation-chain.ts) at the moment the entry was written, so audits
   * can reconstruct the full path (root user/orchestrator → every
   * intermediate actor) from the ledger alone. Optional/additive: chain-less
   * entries are unchanged.
   */
  delegation_chain?: DelegationChain;
  decision?: string;
  evidence?: string[];
  source_event_id?: string;
  payload?: Record<string, unknown>;
  /** Canonical system/entity scope; legacy mission_id remains first-class. */
  scope?: EventScope;
}

export interface AppendMissionExecutionLedgerEntryInput extends Omit<
  MissionExecutionLedgerEntry,
  'ts' | 'mission_id'
> {
  mission_id: string;
  mission_path_hint?: string;
}

interface MissionBindingPaths {
  missionPath: string;
  teamBlueprintPath: string;
  staffingAssignmentsPath: string;
  executionLedgerPath: string;
}

function normalizeMissionId(missionId: string): string {
  return missionId.trim().toUpperCase();
}

function resolveMissionBindingPaths(
  missionId: string,
  missionPathHint?: string
): MissionBindingPaths {
  const normalizedMissionId = normalizeMissionId(missionId);
  assertMissionIdArgument(normalizedMissionId);
  const missionPath =
    missionPathHint ||
    findMissionPath(normalizedMissionId) ||
    missionDir(normalizedMissionId, 'public');
  return {
    missionPath,
    teamBlueprintPath: path.join(missionPath, 'team-blueprint.json'),
    staffingAssignmentsPath: path.join(missionPath, 'staffing-assignments.json'),
    executionLedgerPath: path.join(missionPath, 'execution-ledger.jsonl'),
  };
}

function buildAssignmentId(missionId: string, teamRole: string, actorId: string): string {
  return `${missionId}:${teamRole}:${actorId}`.toLowerCase().replace(/[^a-z0-9:_-]+/g, '-');
}

/**
 * NI-01: canonical runtime identity for an *agent* resource — prefer an
 * explicitly carried nhi_id, else derive `kyberion://agent/<org>/<slug>` from
 * the resource id. Humans keep `null`; services keep whatever external
 * identity they declared (e.g. `stripe-prod`) — only kyberion agents get the
 * nhi derivation.
 */
function resolveAgentRuntimeIdentity(
  resourceType: MissionActorType,
  actorId: string,
  explicit: string | null | undefined,
  organizationId: string | undefined
): string | null {
  if (explicit?.trim()) return explicit;
  if (resourceType !== 'agent') return null;
  return deriveAgentNhiId(actorId, organizationId);
}

function resourceFromLegacyAssignment(
  assignment: MissionTeamPlan['assignments'][number],
  organizationId?: string
): WorkforceResourceRef | null {
  const actorId = assignment.agent_id?.trim();
  if (!actorId) return null;
  const resourceType = assignment.actor_type || 'agent';
  return {
    resource_id: actorId,
    resource_type: resourceType,
    display_name: actorId,
    authority_roles: assignment.authority_role ? [assignment.authority_role] : [],
    capabilities: assignment.required_capabilities || [],
    availability: { status: 'available' },
    cost_profile: {},
    status: 'active',
    // Legacy fixtures predate accountable ownership. New resource refs enforce this at input time.
    accountable_human_id: assignment.accountable_human_id || null,
    provider: assignment.provider,
    model_id: assignment.modelId,
    runtime_identity: resolveAgentRuntimeIdentity(
      resourceType,
      actorId,
      assignment.runtime_identity,
      organizationId
    ),
  };
}

function resolveAssignmentResource(
  assignment: MissionTeamPlan['assignments'][number],
  organizationId?: string
): WorkforceResourceRef | null {
  const resource = assignment.resource;
  if (resource) {
    if (resource.status !== 'active') return null;
    if (resource.resource_type !== 'human' && !resource.accountable_human_id) {
      throw new Error(
        `Workforce resource ${resource.resource_id} requires accountable_human_id for ${resource.resource_type}`
      );
    }
    const runtimeIdentity = resolveAgentRuntimeIdentity(
      resource.resource_type,
      resource.resource_id,
      resource.runtime_identity,
      organizationId
    );
    if (runtimeIdentity !== (resource.runtime_identity ?? null)) {
      return { ...resource, runtime_identity: runtimeIdentity };
    }
    return resource;
  }
  return resourceFromLegacyAssignment(assignment, organizationId);
}

/**
 * NI-01: ensure a durable 'provisioned' AgentIdentity exists for a staffed
 * agent resource. Best-effort by design (never fails staffing): the ledger
 * write requires an allowlisted execution context (mission staffing runs
 * under `mission_controller`) and an accountable human (resource >
 * organization profile fallback); refusals are logged by the helper.
 */
function provisionStaffedAgentIdentity(resource: WorkforceResourceRef, missionId: string): void {
  if (resource.resource_type !== 'agent' || !resource.runtime_identity) return;
  const parsed = parseNhiId(resource.runtime_identity);
  if (!parsed) return;
  ensureAgentIdentityBestEffort({
    slug: parsed.slug,
    kind: 'agent',
    organizationId: parsed.organization_id,
    displayName: resource.display_name,
    accountableHumanId: resource.accountable_human_id ?? undefined,
    affiliation: { mission_id: missionId },
    providerHint: resource.provider ?? undefined,
    modelHint: resource.model_id ?? undefined,
  });
}

export function buildMissionTeamBlueprint(plan: MissionTeamPlan): MissionTeamBlueprint {
  return {
    version: '1.0.0',
    mission_id: plan.mission_id,
    mission_type: plan.mission_type,
    generated_at: new Date().toISOString(),
    source_artifact: 'team-composition.json',
    organization_profile: plan.organization_profile,
    team_governance: plan.team_governance,
    roles: plan.assignments.map((assignment) => ({
      team_role: assignment.team_role,
      required: assignment.required,
      ownership_scope: assignment.delegation_contract?.ownership_scope || '',
      allowed_delegate_team_roles:
        assignment.delegation_contract?.allowed_delegate_team_roles || [],
      escalation_parent_team_role:
        assignment.delegation_contract?.escalation_parent_team_role || null,
      required_scope_classes: assignment.delegation_contract?.required_scope_classes || [],
    })),
  };
}

export function buildMissionStaffingAssignments(plan: MissionTeamPlan): MissionStaffingAssignments {
  const organizationId = plan.organization_profile?.organization_id;
  const assignments: MissionStaffingAssignment[] = plan.assignments
    .filter((assignment) => assignment.status === 'assigned')
    .flatMap((assignment) => {
      const resource = resolveAssignmentResource(assignment, organizationId);
      if (!resource) return [];
      // NI-01: staffed agents get a durable 'provisioned' identity in the
      // ledger (resolve-or-issue, best-effort — see helper docs).
      provisionStaffedAgentIdentity(resource, plan.mission_id);
      const actorId = resource.resource_id;
      return [
        {
          assignment_id: buildAssignmentId(plan.mission_id, assignment.team_role, actorId),
          mission_id: plan.mission_id,
          team_role: assignment.team_role,
          actor_id: actorId,
          actor_type: resource.resource_type,
          authority_role: assignment.authority_role,
          provider: resource.provider ?? assignment.provider,
          model_id: resource.model_id ?? assignment.modelId,
          assigned_at: plan.generated_at,
          released_at: null,
          status: 'active',
          source: 'team_composition',
          organization_role_id: assignment.organization_role_id,
          perspective_ids: assignment.perspective_ids,
          reasoning_route_id: assignment.reasoning_route_id,
          security_scope: assignment.security_scope,
          selection_reason_codes: assignment.selection_reason_codes,
          delegation_contract: assignment.delegation_contract,
          resource,
        },
      ];
    });

  return {
    version: '1.0.0',
    mission_id: plan.mission_id,
    generated_at: new Date().toISOString(),
    organization_profile: plan.organization_profile,
    assignments,
  };
}

export function initializeMissionTeamBindings(
  missionPath: string,
  plan: MissionTeamPlan
): MissionBindingPaths {
  const paths: MissionBindingPaths = {
    missionPath,
    teamBlueprintPath: path.join(missionPath, 'team-blueprint.json'),
    staffingAssignmentsPath: path.join(missionPath, 'staffing-assignments.json'),
    executionLedgerPath: path.join(missionPath, 'execution-ledger.jsonl'),
  };

  safeMkdir(missionPath, { recursive: true });
  const blueprint = buildMissionTeamBlueprint(plan);
  const staffingAssignments = buildMissionStaffingAssignments(plan);
  safeWriteFile(paths.teamBlueprintPath, JSON.stringify(blueprint, null, 2));
  safeWriteFile(paths.staffingAssignmentsPath, JSON.stringify(staffingAssignments, null, 2));
  if (!safeExistsSync(paths.executionLedgerPath)) {
    safeWriteFile(paths.executionLedgerPath, '');
  }
  return paths;
}

export function loadMissionStaffingAssignments(
  missionId: string,
  missionPathHint?: string
): MissionStaffingAssignments | null {
  const paths = resolveMissionBindingPaths(missionId, missionPathHint);
  if (!safeExistsSync(paths.staffingAssignmentsPath)) return null;
  const parsed = readJson<
    Omit<MissionStaffingAssignments, 'assignments'> & {
      assignments?: Array<Partial<MissionStaffingAssignment>>;
    }
  >(paths.staffingAssignmentsPath);
  const assignments = (parsed.assignments || []).flatMap((assignment) => {
    const actorId = String(assignment.actor_id || '').trim();
    if (!actorId) return [];
    const legacyResourceType = assignment.actor_type || 'agent';
    const resource: WorkforceResourceRef = assignment.resource || {
      resource_id: actorId,
      resource_type: legacyResourceType,
      display_name: actorId,
      authority_roles: assignment.authority_role ? [assignment.authority_role] : [],
      capabilities: [],
      availability: { status: 'available' },
      cost_profile: {},
      status: assignment.status === 'released' ? 'suspended' : 'active',
      accountable_human_id: null,
      provider: assignment.provider ?? null,
      model_id: assignment.model_id ?? null,
      // NI-01: legacy artifacts predate durable identities — normalize agent
      // rows to their canonical nhi_id on read (pure derivation, no ledger IO).
      runtime_identity: resolveAgentRuntimeIdentity(
        legacyResourceType,
        actorId,
        null,
        parsed.organization_profile?.organization_id
      ),
    };
    return [
      {
        ...assignment,
        actor_id: actorId,
        actor_type: resource.resource_type,
        resource,
      } as MissionStaffingAssignment,
    ];
  });
  return { ...parsed, assignments } as MissionStaffingAssignments;
}

/**
 * NI-01: resolve the acting resource's durable identity for a ledger entry
 * when the caller did not supply one: the mission's staffing assignments on
 * disk are the authority (they carry the org-scoped nhi_id stamped at
 * staffing time). Best-effort — attribution must never fail the append.
 */
function resolveLedgerRuntimeIdentity(
  input: AppendMissionExecutionLedgerEntryInput,
  missionId: string
): string | undefined {
  if (input.runtime_identity) return input.runtime_identity;
  if (!input.actor_id) return undefined;
  try {
    const staffing = loadMissionStaffingAssignments(missionId, input.mission_path_hint);
    const match = staffing?.assignments.find(
      (assignment) => assignment.actor_id === input.actor_id
    );
    return match?.resource.runtime_identity ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * NI-03: resolve the entry's delegation chain — a typed `delegation_chain`
 * input wins; otherwise a chain riding in `payload.delegation_chain` (the
 * mission-task-events pass-through: emitMissionTaskEvent forwards event
 * payloads verbatim, so the worker stamps the chain there and this seam
 * promotes it to the first-class ledger column). Best-effort: a malformed
 * payload chain is dropped, never fails the append.
 */
function resolveLedgerDelegationChain(
  input: AppendMissionExecutionLedgerEntryInput
): DelegationChain | undefined {
  if (input.delegation_chain) return input.delegation_chain;
  const fromPayload = input.payload?.delegation_chain;
  if (fromPayload === undefined) return undefined;
  return parseDelegationChain(fromPayload) ?? undefined;
}

function resolveMissionLedgerScope(
  input: AppendMissionExecutionLedgerEntryInput,
  missionId: string,
  missionPath: string
): EventScope {
  let state: Record<string, unknown> = {};
  const statePath = path.join(missionPath, 'mission-state.json');
  if (safeExistsSync(statePath)) {
    try {
      state = readJson<Record<string, unknown>>(statePath);
    } catch {
      state = {};
    }
  }
  const candidate: EventScopeInput = {
    tier: (state.tier_scope || state.tier || 'public') as EventScope['tier'],
    mission_id: missionId,
    ...(typeof state.tenant_slug === 'string' ? { tenant_slug: state.tenant_slug } : {}),
    ...(typeof state.organization_id === 'string'
      ? { organization_id: state.organization_id }
      : {}),
    ...(typeof state.project_id === 'string' ? { project_id: state.project_id } : {}),
  };
  let authority: EventScope;
  try {
    authority = normalizeEventScope(candidate);
  } catch {
    // Legacy public/shared missions remain queryable as mission-scoped but
    // untenantable records; tenant readers must not infer a tenant from them.
    authority = normalizeEventScope({ tier: 'public', mission_id: missionId });
  }
  return resolveEventScopeAgainstAuthority(authority, input.scope, {
    mission_id: missionId,
    ...(input.task_id ? { task_id: input.task_id, scope_kind: 'task' } : { scope_kind: 'mission' }),
  });
}

export function appendMissionExecutionLedgerEntry(
  input: AppendMissionExecutionLedgerEntryInput
): string {
  const missionId = normalizeMissionId(input.mission_id);
  const missionPathHint = input.mission_path_hint;
  const paths = resolveMissionBindingPaths(missionId, missionPathHint);
  const entryPayload: Omit<MissionExecutionLedgerEntry, 'ts' | 'mission_id'> = {
    event_type: input.event_type,
    task_id: input.task_id,
    team_role: input.team_role,
    actor_id: input.actor_id,
    actor_type: input.actor_type,
    runtime_identity: resolveLedgerRuntimeIdentity(input, missionId),
    delegation_chain: resolveLedgerDelegationChain(input),
    decision: input.decision,
    evidence: input.evidence,
    source_event_id: input.source_event_id,
    payload: input.payload,
    scope: resolveMissionLedgerScope(input, missionId, paths.missionPath),
  };
  safeMkdir(paths.missionPath, { recursive: true });
  if (!safeExistsSync(paths.executionLedgerPath)) {
    safeWriteFile(paths.executionLedgerPath, '');
  }
  const entry: MissionExecutionLedgerEntry = {
    ts: new Date().toISOString(),
    mission_id: missionId,
    ...entryPayload,
  };
  appendJsonLine(paths.executionLedgerPath, entry);
  return paths.executionLedgerPath;
}
