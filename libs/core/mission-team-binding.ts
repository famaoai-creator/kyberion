import * as path from 'node:path';
import { findMissionPath, missionDir } from './path-resolver.js';
import type { MissionTeamPlan } from './mission-team-composer.js';
import { safeAppendFileSync, safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';

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
  roles: TeamBlueprintRole[];
}

export type MissionActorType = 'agent' | 'human' | 'service';

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
}

export interface MissionStaffingAssignments {
  version: '1.0.0';
  mission_id: string;
  generated_at: string;
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

export interface AppendMissionExecutionLedgerEntryInput extends Omit<MissionExecutionLedgerEntry, 'ts' | 'mission_id'> {
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

function resolveMissionBindingPaths(missionId: string, missionPathHint?: string): MissionBindingPaths {
  const normalizedMissionId = normalizeMissionId(missionId);
  const missionPath = missionPathHint || findMissionPath(normalizedMissionId) || missionDir(normalizedMissionId, 'public');
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

export function buildMissionTeamBlueprint(plan: MissionTeamPlan): MissionTeamBlueprint {
  return {
    version: '1.0.0',
    mission_id: plan.mission_id,
    mission_type: plan.mission_type,
    generated_at: new Date().toISOString(),
    source_artifact: 'team-composition.json',
    roles: plan.assignments.map((assignment) => ({
      team_role: assignment.team_role,
      required: assignment.required,
      ownership_scope: assignment.delegation_contract?.ownership_scope || '',
      allowed_delegate_team_roles: assignment.delegation_contract?.allowed_delegate_team_roles || [],
      escalation_parent_team_role: assignment.delegation_contract?.escalation_parent_team_role || null,
      required_scope_classes: assignment.delegation_contract?.required_scope_classes || [],
    })),
  };
}

export function buildMissionStaffingAssignments(plan: MissionTeamPlan): MissionStaffingAssignments {
  const assignments: MissionStaffingAssignment[] = plan.assignments
    .filter((assignment) => assignment.status === 'assigned' && assignment.agent_id)
    .map((assignment) => ({
      assignment_id: buildAssignmentId(plan.mission_id, assignment.team_role, assignment.agent_id || ''),
      mission_id: plan.mission_id,
      team_role: assignment.team_role,
      actor_id: assignment.agent_id || '',
      actor_type: 'agent',
      authority_role: assignment.authority_role,
      provider: assignment.provider,
      model_id: assignment.modelId,
      assigned_at: plan.generated_at,
      released_at: null,
      status: 'active',
      source: 'team_composition',
    }));

  return {
    version: '1.0.0',
    mission_id: plan.mission_id,
    generated_at: new Date().toISOString(),
    assignments,
  };
}

export function initializeMissionTeamBindings(missionPath: string, plan: MissionTeamPlan): MissionBindingPaths {
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

export function loadMissionStaffingAssignments(missionId: string): MissionStaffingAssignments | null {
  const paths = resolveMissionBindingPaths(missionId);
  if (!safeExistsSync(paths.staffingAssignmentsPath)) return null;
  return JSON.parse(safeReadFile(paths.staffingAssignmentsPath, { encoding: 'utf8' }) as string) as MissionStaffingAssignments;
}

export function appendMissionExecutionLedgerEntry(input: AppendMissionExecutionLedgerEntryInput): string {
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
