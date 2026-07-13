import * as path from 'node:path';
import { loadJson, safeExistsSync, safeWriteFile } from './secure-io.js';
import * as pathResolver from './path-resolver.js';
import {
  selectAgentForTeamRole,
  type AuthorityRoleRecord,
  type AgentProfileRecord,
  type MissionTeamAssignment,
  type TeamRoleRecord,
} from './team-role-assignment-selection.js';
import { resolveTaskModelHint } from './reasoning-model-routing.js';
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
import {
  resolveOrganizationOrgChart,
  summarizeOrganizationOrgChart,
  type OrganizationOrgChartSummary,
} from './org-chart.js';
import { resolveParticipantContext, type ParticipantRisk } from './participant-context-resolver.js';

export interface MissionTeamPlan {
  mission_id: string;
  mission_type: string;
  tier: string;
  template: string;
  assigned_persona?: string;
  organization_profile?: MissionTeamOrganizationProfileSummary;
  organization_chart?: OrganizationOrgChartSummary;
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

function buildTeamGovernance(
  template: MissionTeamTemplateRecord,
  assignments: MissionTeamAssignment[]
): MissionTeamGovernance {
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
  const assignedRoles = assignments
    .filter((entry) => entry.status === 'assigned')
    .map((entry) => entry.team_role);
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

function enrichAssignmentContext(input: {
  assignment: MissionTeamAssignment;
  missionId: string;
  tier: 'personal' | 'confidential' | 'public';
  tenantId: string;
  risk: string;
}): MissionTeamAssignment {
  const assignment = input.assignment;
  if (assignment.status !== 'assigned' || !assignment.agent_id || !assignment.authority_role) {
    return assignment;
  }
  const participantId = `${assignment.agent_id}:${assignment.team_role}`;
  const resolution = resolveParticipantContext({
    participant_id: participantId,
    team_role_id: assignment.team_role,
    agent_profile_id: assignment.agent_id,
    authority_role_id: assignment.authority_role,
    risk: input.risk as ParticipantRisk,
    security_scope: {
      tenant_id: input.tenantId,
      mission_id: input.missionId,
      participant_id: participantId,
      read_tiers:
        input.tier === 'public'
          ? ['public']
          : input.tier === 'confidential'
            ? ['public', 'confidential']
            : ['public', 'personal'],
      write_tier: input.tier,
      purpose: assignment.team_role,
      external_egress: input.tier === 'public' ? 'allow' : 'deny',
    },
  });
  return {
    ...assignment,
    organization_role_id: resolution.participant.organization_role_id,
    perspective_ids: resolution.participant.perspective_ids,
    reasoning_route_id: resolution.participant.reasoning_route_id,
    security_scope: resolution.participant.security_scope,
    selection_reason_codes: resolution.selection_reason_codes,
  };
}

export function summarizeMissionOrganizationProfile(
  organizationProfile?: OrganizationProfile | null
): MissionTeamOrganizationProfileSummary | undefined {
  if (!organizationProfile) return undefined;
  return {
    organization_id: organizationProfile.organization_id,
    name: organizationProfile.name,
    default_team_template:
      organizationProfile.mission_defaults?.default_team_template ||
      organizationProfile.team_defaults?.default_team_template,
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
  const missionType =
    input.missionType || mapMissionClassToMissionTypeTemplate(missionClassification.mission_class);
  const templates = loadMissionTeamTemplates(organizationProfile);
  const teamRoles = loadTeamRoleIndex();
  const authorityRoles = loadAuthorityRoleIndex();
  const agents = loadAgentProfileIndex();
  const organizationChart = summarizeOrganizationOrgChart(
    resolveOrganizationOrgChart(organizationProfile?.organization_id || null)
  );
  const organizationDefaultTemplate = organizationProfile?.mission_defaults?.default_team_template;
  const template = (templates[missionType] ||
    (organizationDefaultTemplate ? templates[organizationDefaultTemplate] : undefined) ||
    templates.default) as MissionTeamTemplateRecord;
  const assignments: MissionTeamAssignment[] = [];
  const preferredAgentId = organizationProfile?.mission_defaults?.default_agent_profile
    ?.trim()
    .toLowerCase();
  const missionTaskModelHint = resolveTaskModelHint({
    phase_kind:
      missionClassification.stage === 'planning' ||
      missionClassification.stage === 'contract_authoring'
        ? 'plan'
        : missionClassification.stage === 'verification' ||
            missionClassification.stage === 'retrospective'
          ? 'review'
          : missionClassification.stage === 'execution'
            ? 'implement'
            : 'mechanical',
    estimated_scope:
      missionClassification.delivery_shape === 'long_running_job' ||
      missionClassification.delivery_shape === 'cross_system_change'
        ? 'L'
        : missionClassification.delivery_shape === 'single_artifact'
          ? 'S'
          : 'M',
    risk: missionClassification.risk_profile,
  });

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
        model_hint: missionTaskModelHint,
      });
      continue;
    }
    assignments.push(
      enrichAssignmentContext({
        assignment: {
          ...selectAgentForTeamRole(
            role,
            preferredAgentId &&
              !roleRecord.selection_hints?.preferred_agents?.includes(preferredAgentId)
              ? {
                  ...roleRecord,
                  selection_hints: {
                    ...(roleRecord.selection_hints || {}),
                    preferred_agents: [
                      preferredAgentId,
                      ...(roleRecord.selection_hints?.preferred_agents || []).filter(
                        (agent) => agent !== preferredAgentId
                      ),
                    ],
                  },
                }
              : roleRecord,
            authorityRoles,
            agents,
            missionTaskModelHint
          ),
          model_hint: missionTaskModelHint,
        },
        missionId: input.missionId,
        tier: input.tier,
        tenantId: organizationProfile?.organization_id || 'default',
        risk: missionClassification.risk_profile,
      })
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
                ...(roleRecord.selection_hints?.preferred_agents || []).filter(
                  (agent) => agent !== preferredAgentId
                ),
              ],
            },
          }
        : roleRecord,
      authorityRoles,
      agents,
      missionTaskModelHint
    );
    assignment.required = false;
    assignment.model_hint = missionTaskModelHint;
    assignments.push(
      enrichAssignmentContext({
        assignment,
        missionId: input.missionId,
        tier: input.tier,
        tenantId: organizationProfile?.organization_id || 'default',
        risk: missionClassification.risk_profile,
      })
    );
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
    organization_chart: organizationChart,
    mission_classification: missionClassification,
    generated_at: new Date().toISOString(),
    team_governance: buildTeamGovernance(template, assignments),
    assignments,
  };
}

export function enrichMissionTeamPlanWithOrganizationProfile(
  plan: MissionTeamPlan,
  organizationProfile?: OrganizationProfile | null
): MissionTeamPlan {
  const organization_profile = summarizeMissionOrganizationProfile(organizationProfile);
  const organization_chart = summarizeOrganizationOrgChart(
    resolveOrganizationOrgChart(organizationProfile?.organization_id || null)
  );
  const profileMatches =
    !organization_profile ||
    (plan.organization_profile &&
      plan.organization_profile.organization_id === organization_profile.organization_id &&
      plan.organization_profile.name === organization_profile.name &&
      plan.organization_profile.default_team_template ===
        organization_profile.default_team_template &&
      plan.organization_profile.team_template_catalog_id ===
        organization_profile.team_template_catalog_id &&
      plan.organization_profile.default_agent_profile ===
        organization_profile.default_agent_profile);
  const chartMatches =
    !organization_chart ||
    (plan.organization_chart &&
      plan.organization_chart.organization_id === organization_chart.organization_id &&
      plan.organization_chart.name === organization_chart.name &&
      plan.organization_chart.source_kind === organization_chart.source_kind &&
      plan.organization_chart.domain_count === organization_chart.domain_count &&
      plan.organization_chart.position_count === organization_chart.position_count);
  if (profileMatches && chartMatches) {
    return plan;
  }
  return {
    ...plan,
    organization_profile,
    organization_chart,
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
  teamRole: string
): MissionTeamAssignment | null {
  return plan.assignments.find((entry) => entry.team_role === teamRole) || null;
}

export function resolveMissionTeamReceiver(input: {
  missionId: string;
  teamRole: string;
  excludedAgentIds?: string[];
  requiredCapabilities?: string[];
}): MissionTeamAssignment | null {
  const plan = loadMissionTeamPlan(input.missionId);
  if (!plan) return null;
  const assignment = getMissionTeamAssignment(plan, input.teamRole);
  if (!assignment || assignment.status !== 'assigned' || !assignment.agent_id) return null;
  const excludedAgentIds = new Set(
    (input.excludedAgentIds || []).map((entry) => entry.trim().toLowerCase()).filter(Boolean)
  );
  const requiredCapabilities = Array.from(
    new Set(
      (input.requiredCapabilities || []).map((entry) => entry.trim().toLowerCase()).filter(Boolean)
    )
  );
  if (excludedAgentIds.size === 0 && requiredCapabilities.length === 0) return assignment;

  const agents = loadAgentProfileIndex();
  const currentProfile = agents[assignment.agent_id];
  const currentCapabilities = new Set(
    (currentProfile?.capabilities || []).map((entry) => entry.trim().toLowerCase())
  );
  if (
    !excludedAgentIds.has(assignment.agent_id.toLowerCase()) &&
    requiredCapabilities.every((capability) => currentCapabilities.has(capability))
  ) {
    return assignment;
  }

  const roleRecord = loadTeamRoleIndex()[input.teamRole];
  if (!roleRecord) return null;
  const eligibleAgents = Object.fromEntries(
    Object.entries(agents).filter(([agentId]) => !excludedAgentIds.has(agentId.toLowerCase()))
  );
  const selected = selectAgentForTeamRole(
    input.teamRole,
    {
      ...roleRecord,
      required_capabilities: Array.from(
        new Set([...(roleRecord.required_capabilities || []), ...requiredCapabilities])
      ),
    },
    loadAuthorityRoleIndex(),
    eligibleAgents,
    assignment.model_hint
  );
  if (selected.status !== 'assigned' || !selected.agent_id) return null;
  const selectedCapabilities = new Set(
    (eligibleAgents[selected.agent_id]?.capabilities || []).map((entry) =>
      entry.trim().toLowerCase()
    )
  );
  if (!requiredCapabilities.every((capability) => selectedCapabilities.has(capability))) {
    return null;
  }
  return enrichAssignmentContext({
    assignment: {
      ...selected,
      model_hint: assignment.model_hint,
    },
    missionId: plan.mission_id,
    tier: plan.tier as 'personal' | 'confidential' | 'public',
    tenantId: plan.organization_profile?.organization_id || 'default',
    risk: plan.mission_classification?.risk_profile || 'low',
  });
}

export type {
  AuthorityRoleRecord,
  AgentProfileRecord,
  MissionTeamAssignment,
  TeamRoleRecord,
} from './team-role-assignment-selection.js';

export function buildMissionTeamView(plan: MissionTeamPlan): Record<string, string> {
  const view: Record<string, string> = {};
  for (const assignment of plan.assignments) {
    if (assignment.status === 'assigned' && assignment.agent_id) {
      view[assignment.team_role] = assignment.agent_id;
    }
  }
  return view;
}
