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
import { loadOrganizationProfile, type OrganizationProfile } from './organization-profile.js';

export interface MissionTeamPlan {
  mission_id: string;
  mission_type: string;
  tier: string;
  template: string;
  assigned_persona?: string;
  organization_profile?: MissionTeamOrganizationProfileSummary;
  mission_classification?: MissionClassification;
  generated_at: string;
  team_governance?: MissionTeamGovernance;
  assignments: MissionTeamAssignment[];
}

export interface MissionTeamOrganizationProfileSummary {
  organization_id: string;
  name: string;
  default_team_template?: string;
  team_template_catalog_id?: string;
  default_agent_profile?: string;
}

export interface MissionTeamLifecyclePolicy {
  max_parallel_members: number;
  max_members: number;
  max_messages_per_run: number;
  max_wall_clock_minutes: number;
  max_member_turns: number;
  shutdown_policy: 'graceful_handoff' | 'manual' | 'auto_shutdown';
  resume_policy: 'checkpoint_resume' | 'manual_resume';
  cooldown_minutes: number;
}

export interface MissionTeamCompositionSummary {
  required_roles: string[];
  optional_roles: string[];
  assigned_roles: string[];
  unfilled_required_roles: string[];
}

export interface MissionTeamGovernance {
  lifecycle: MissionTeamLifecyclePolicy;
  composition: MissionTeamCompositionSummary;
}

interface MissionTeamTemplateRecord {
  required_roles: string[];
  optional_roles: string[];
  lifecycle?: MissionTeamLifecyclePolicy;
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
  organizationProfile?: OrganizationProfile | null;
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
}

function buildTeamGovernance(template: MissionTeamTemplateRecord, assignments: MissionTeamAssignment[]): MissionTeamGovernance {
  const lifecycle = template.lifecycle || {
    max_parallel_members: template.required_roles.length,
    max_members: template.required_roles.length + template.optional_roles.length,
    max_messages_per_run: 40,
    max_wall_clock_minutes: 120,
    max_member_turns: 8,
    shutdown_policy: 'graceful_handoff',
    resume_policy: 'checkpoint_resume',
    cooldown_minutes: 5,
  };
  const assignedRoles = assignments.filter((entry) => entry.status === 'assigned').map((entry) => entry.team_role);
  const unfilledRequiredRoles = assignments
    .filter((entry) => entry.required && entry.status !== 'assigned')
    .map((entry) => entry.team_role);
  return {
    lifecycle,
    composition: {
      required_roles: [...template.required_roles],
      optional_roles: [...template.optional_roles],
      assigned_roles: assignedRoles,
      unfilled_required_roles: unfilledRequiredRoles,
    },
  };
}

export function summarizeMissionOrganizationProfile(
  organizationProfile?: OrganizationProfile | null,
): MissionTeamOrganizationProfileSummary | undefined {
  if (!organizationProfile) return undefined;
  return {
    organization_id: organizationProfile.organization_id,
    name: organizationProfile.name,
    default_team_template: organizationProfile.mission_defaults?.default_team_template || organizationProfile.team_defaults?.default_team_template,
    team_template_catalog_id: organizationProfile.team_defaults?.team_template_catalog_id,
    default_agent_profile: organizationProfile.mission_defaults?.default_agent_profile,
  };
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
  organizationProfile?: OrganizationProfile | null;
}): MissionTeamPlan {
  const organizationProfile = input.organizationProfile ?? loadOrganizationProfile();
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
  const templates = loadMissionTeamTemplates(organizationProfile);
  const teamRoles = loadTeamRoleIndex();
  const authorityRoles = loadAuthorityRoleIndex();
  const agents = loadAgentProfileIndex();
  const organizationDefaultTemplate = organizationProfile?.mission_defaults?.default_team_template;
  const template = (templates[missionType] || (organizationDefaultTemplate ? templates[organizationDefaultTemplate] : undefined) || templates.default) as MissionTeamTemplateRecord;
  const assignments: MissionTeamAssignment[] = [];
  const preferredAgentId = organizationProfile?.mission_defaults?.default_agent_profile?.trim().toLowerCase();

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
    assignments.push(
      selectAgentForTeamRole(
        role,
        preferredAgentId && !roleRecord.selection_hints?.preferred_agents?.includes(preferredAgentId)
          ? {
              ...roleRecord,
              selection_hints: {
                ...(roleRecord.selection_hints || {}),
                preferred_agents: [
                  preferredAgentId,
                  ...((roleRecord.selection_hints?.preferred_agents || []).filter((agent) => agent !== preferredAgentId)),
                ],
              },
            }
          : roleRecord,
        authorityRoles,
        agents,
      )
    );
  }

  for (const role of template.optional_roles) {
    const roleRecord = teamRoles[role];
    if (!roleRecord) continue;
    const assignment = selectAgentForTeamRole(
      role,
      preferredAgentId && !roleRecord.selection_hints?.preferred_agents?.includes(preferredAgentId)
        ? {
            ...roleRecord,
            selection_hints: {
              ...(roleRecord.selection_hints || {}),
              preferred_agents: [
                preferredAgentId,
                ...((roleRecord.selection_hints?.preferred_agents || []).filter((agent) => agent !== preferredAgentId)),
              ],
            },
          }
        : roleRecord,
      authorityRoles,
      agents,
    );
    assignment.required = false;
    assignments.push(assignment);
  }

  return {
    mission_id: input.missionId,
    mission_type: missionType,
    tier: input.tier,
    template: templates[missionType]
      ? missionType
      : organizationDefaultTemplate && templates[organizationDefaultTemplate]
        ? organizationDefaultTemplate
        : 'default',
    assigned_persona: input.assignedPersona,
    organization_profile: summarizeMissionOrganizationProfile(organizationProfile),
    mission_classification: missionClassification,
    generated_at: new Date().toISOString(),
    team_governance: buildTeamGovernance(template, assignments),
    assignments,
  };
}

export function enrichMissionTeamPlanWithOrganizationProfile(
  plan: MissionTeamPlan,
  organizationProfile?: OrganizationProfile | null,
): MissionTeamPlan {
  const organization_profile = summarizeMissionOrganizationProfile(organizationProfile);
  if (!organization_profile) return plan;
  if (
    plan.organization_profile &&
    plan.organization_profile.organization_id === organization_profile.organization_id &&
    plan.organization_profile.name === organization_profile.name &&
    plan.organization_profile.default_team_template === organization_profile.default_team_template &&
    plan.organization_profile.team_template_catalog_id === organization_profile.team_template_catalog_id &&
    plan.organization_profile.default_agent_profile === organization_profile.default_agent_profile
  ) {
    return plan;
  }
  return {
    ...plan,
    organization_profile,
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
    organizationProfile: input.organizationProfile,
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
