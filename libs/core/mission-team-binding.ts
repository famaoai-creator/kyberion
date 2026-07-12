import * as path from 'node:path';
import { findMissionPath, missionDir } from './path-resolver.js';
import type { MissionTeamPlan } from './mission-team-plan-composer.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import type {
  MissionTeamGovernance,
  MissionTeamOrganizationProfileSummary,
} from './mission-team-plan-composer.js';

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
  decision?: string;
  evidence?: string[];
  source_event_id?: string;
  payload?: Record<string, unknown>;
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

function resourceFromLegacyAssignment(
  assignment: MissionTeamPlan['assignments'][number]
): WorkforceResourceRef | null {
  const actorId = assignment.agent_id?.trim();
  if (!actorId) return null;
  return {
    resource_id: actorId,
    resource_type: assignment.actor_type || 'agent',
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
    runtime_identity: assignment.runtime_identity || null,
  };
}

function resolveAssignmentResource(
  assignment: MissionTeamPlan['assignments'][number]
): WorkforceResourceRef | null {
  const resource = assignment.resource;
  if (resource) {
    if (resource.status !== 'active') return null;
    if (resource.resource_type !== 'human' && !resource.accountable_human_id) {
      throw new Error(
        `Workforce resource ${resource.resource_id} requires accountable_human_id for ${resource.resource_type}`
      );
    }
    return resource;
  }
  return resourceFromLegacyAssignment(assignment);
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
  const assignments: MissionStaffingAssignment[] = plan.assignments
    .filter((assignment) => assignment.status === 'assigned')
    .flatMap((assignment) => {
      const resource = resolveAssignmentResource(assignment);
      if (!resource) return [];
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
  const parsed = JSON.parse(
    safeReadFile(paths.staffingAssignmentsPath, { encoding: 'utf8' }) as string
  ) as Omit<MissionStaffingAssignments, 'assignments'> & {
    assignments?: Array<Partial<MissionStaffingAssignment>>;
  };
  const assignments = (parsed.assignments || []).flatMap((assignment) => {
    const actorId = String(assignment.actor_id || '').trim();
    if (!actorId) return [];
    const resource: WorkforceResourceRef = assignment.resource || {
      resource_id: actorId,
      resource_type: assignment.actor_type || 'agent',
      display_name: actorId,
      authority_roles: assignment.authority_role ? [assignment.authority_role] : [],
      capabilities: [],
      availability: { status: 'available' },
      cost_profile: {},
      status: assignment.status === 'released' ? 'suspended' : 'active',
      accountable_human_id: null,
      provider: assignment.provider ?? null,
      model_id: assignment.model_id ?? null,
      runtime_identity: null,
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

export function appendMissionExecutionLedgerEntry(
  input: AppendMissionExecutionLedgerEntryInput
): string {
  const missionId = normalizeMissionId(input.mission_id);
  const missionPathHint = input.mission_path_hint;
  const entryPayload: Omit<MissionExecutionLedgerEntry, 'ts' | 'mission_id'> = {
    event_type: input.event_type,
    task_id: input.task_id,
    team_role: input.team_role,
    actor_id: input.actor_id,
    actor_type: input.actor_type,
    decision: input.decision,
    evidence: input.evidence,
    source_event_id: input.source_event_id,
    payload: input.payload,
  };
  const paths = resolveMissionBindingPaths(missionId, missionPathHint);
  safeMkdir(paths.missionPath, { recursive: true });
  if (!safeExistsSync(paths.executionLedgerPath)) {
    safeWriteFile(paths.executionLedgerPath, '');
  }
  const entry: MissionExecutionLedgerEntry = {
    ts: new Date().toISOString(),
    mission_id: missionId,
    ...entryPayload,
  };
  safeAppendFileSync(paths.executionLedgerPath, `${JSON.stringify(entry)}\n`);
  return paths.executionLedgerPath;
}
