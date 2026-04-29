import * as path from 'node:path';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import * as pathResolver from './path-resolver.js';
import { selectAgentForTeamRole, type AuthorityRoleRecord, type AgentProfileRecord, type MissionTeamAssignment, type TeamRoleRecord } from './team-role-assignment-selection.js';
import {
  mapMissionClassToMissionTypeTemplate,
  resolveMissionClassification,
  type MissionClassification,
} from './mission-classification.js';
import {
  loadAgentProfileIndex,
  loadAuthorityRoleIndex,
  loadMissionTeamTemplates,
  loadTeamRoleIndex,
} from './mission-team-index.js';

export interface MissionTeamPlan {
  mission_id: string;
  mission_type: string;
  tier: string;
  template: string;
  assigned_persona?: string;
  mission_classification?: MissionClassification;
  generated_at: string;
  assignments: MissionTeamAssignment[];
}

export interface ResolveMissionTeamOptions {
  missionId: string;
  missionType?: string;
  intentId?: string;
  taskType?: string;
  shape?: string;
  utterance?: string;
  artifactPaths?: string[];
  progressSignals?: string[];
  tier?: 'personal' | 'confidential' | 'public';
  assignedPersona?: string;
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
}

export function composeMissionTeamPlan(input: {
  missionId: string;
  missionType?: string;
  intentId?: string;
  taskType?: string;
  shape?: string;
  utterance?: string;
  artifactPaths?: string[];
  progressSignals?: string[];
  tier: 'personal' | 'confidential' | 'public';
  assignedPersona?: string;
}): MissionTeamPlan {
  const missionClassification = resolveMissionClassification({
    missionTypeHint: input.missionType,
    intentId: input.intentId,
    taskType: input.taskType,
    shape: input.shape,
    utterance: input.utterance,
    artifactPaths: input.artifactPaths,
    progressSignals: input.progressSignals,
  });
  const missionType = input.missionType || mapMissionClassToMissionTypeTemplate(missionClassification.mission_class);
  const templates = loadMissionTeamTemplates();
  const teamRoles = loadTeamRoleIndex();
  const authorityRoles = loadAuthorityRoleIndex();
  const agents = loadAgentProfileIndex();
  const template = templates[missionType] || templates.default;
  const assignments: MissionTeamAssignment[] = [];

  for (const role of template.required_roles) {
    const roleRecord = teamRoles[role];
    if (!roleRecord) {
      assignments.push({
        team_role: role,
        required: true,
        status: 'unfilled',
        agent_id: null,
        authority_role: null,
        delegation_contract: null,
        provider: null,
        modelId: null,
        required_capabilities: [],
        notes: 'Team role not found in team-role-index',
      });
      continue;
    }
    assignments.push(selectAgentForTeamRole(role, roleRecord, authorityRoles, agents));
  }

  for (const role of template.optional_roles) {
    const roleRecord = teamRoles[role];
    if (!roleRecord) continue;
    const assignment = selectAgentForTeamRole(role, roleRecord, authorityRoles, agents);
    assignment.required = false;
    assignments.push(assignment);
  }

  return {
    mission_id: input.missionId,
    mission_type: missionType,
    tier: input.tier,
    template: templates[missionType] ? missionType : 'default',
    assigned_persona: input.assignedPersona,
    mission_classification: missionClassification,
    generated_at: new Date().toISOString(),
    assignments,
  };
}

export function writeMissionTeamPlan(missionDir: string, plan: MissionTeamPlan): string {
  const targetPath = path.join(missionDir, 'team-composition.json');
  safeWriteFile(targetPath, JSON.stringify(plan, null, 2));
  return targetPath;
}

export function getMissionTeamPlanPath(missionId: string): string | null {
  const missionPath = pathResolver.findMissionPath(missionId.toUpperCase());
  if (!missionPath) return null;
  return path.join(missionPath, 'team-composition.json');
}

export function loadMissionTeamPlan(missionId: string): MissionTeamPlan | null {
  const planPath = getMissionTeamPlanPath(missionId);
  if (!planPath || !safeExistsSync(planPath)) return null;
  return loadJson<MissionTeamPlan>(planPath);
}

export function resolveMissionTeamPlan(input: ResolveMissionTeamOptions): MissionTeamPlan {
  const missionId = input.missionId.toUpperCase();
  const existing = loadMissionTeamPlan(missionId);
  if (existing) return existing;

  return composeMissionTeamPlan({
    missionId,
    missionType: input.missionType,
    intentId: input.intentId,
    taskType: input.taskType,
    shape: input.shape,
    utterance: input.utterance,
    artifactPaths: input.artifactPaths,
    progressSignals: input.progressSignals,
    tier: input.tier || 'public',
    assignedPersona: input.assignedPersona,
  });
}

export function getMissionTeamAssignment(
  plan: MissionTeamPlan,
  teamRole: string,
): MissionTeamAssignment | null {
  return plan.assignments.find((entry) => entry.team_role === teamRole) || null;
}

export function resolveMissionTeamReceiver(input: {
  missionId: string;
  teamRole: string;
}): MissionTeamAssignment | null {
  const plan = loadMissionTeamPlan(input.missionId);
  if (!plan) return null;
  const assignment = getMissionTeamAssignment(plan, input.teamRole);
  if (!assignment || assignment.status !== 'assigned' || !assignment.agent_id) return null;
  return assignment;
}

export type { AuthorityRoleRecord, AgentProfileRecord, MissionTeamAssignment, TeamRoleRecord } from './team-role-assignment-selection.js';

export function buildMissionTeamView(plan: MissionTeamPlan): Record<string, string> {
  const view: Record<string, string> = {};
  for (const assignment of plan.assignments) {
    if (assignment.status === 'assigned' && assignment.agent_id) {
      view[assignment.team_role] = assignment.agent_id;
    }
  }
  return view;
}
