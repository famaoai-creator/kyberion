import * as path from 'node:path';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import * as pathResolver from './path-resolver.js';
import {
  mapMissionClassToMissionTypeTemplate,
  resolveMissionClassification,
  type MissionClassification,
} from './mission-classification.js';
import { resolveMissionWorkflowDesign, type MissionWorkflowDesign } from './mission-workflow-catalog.js';
import { resolveMissionReviewDesign, type MissionReviewDesign } from './mission-review-gates.js';

export interface AuthorityRoleRecord {
  description: string;
  write_scopes: string[];
  scope_classes: string[];
  allowed_actuators: string[];
  tier_access: string[];
}

export interface TeamRoleRecord {
  description: string;
  required_capabilities: string[];
  compatible_authority_roles: string[];
  allowed_delegate_team_roles: string[];
  escalation_parent_team_role: string | null;
  required_scope_classes: string[];
  ownership_scope: string;
  preferred_agents: string[];
  preferred_models: string[];
  autonomy_level: 'low' | 'medium' | 'high';
}

export interface AgentProfileRecord {
  authority_roles: string[];
  team_roles: string[];
  provider: string;
  modelId: string;
  capabilities: string[];
  provider_strategy?: 'strict' | 'preferred' | 'adaptive';
  fallback_providers?: string[];
}

interface MissionTeamTemplate {
  required_roles: string[];
  optional_roles: string[];
}

export interface MissionTeamAssignment {
  team_role: string;
  required: boolean;
  status: 'assigned' | 'unfilled';
  agent_id: string | null;
  authority_role: string | null;
  delegation_contract: {
    ownership_scope: string;
    allowed_delegate_team_roles: string[];
    escalation_parent_team_role: string | null;
    required_scope_classes: string[];
    resolved_scope_classes: string[];
    allowed_write_scopes: string[];
  } | null;
  provider: string | null;
  modelId: string | null;
  required_capabilities: string[];
  notes: string;
}

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

export interface MissionTeamCompositionBriefInput {
  missionId?: string;
  missionType?: string;
  intentId?: string;
  taskType?: string;
  shape?: string;
  request: string;
  artifactPaths?: string[];
  progressSignals?: string[];
  tier?: 'personal' | 'confidential' | 'public';
  assignedPersona?: string;
  executionShape?: 'direct_reply' | 'task_session' | 'mission' | 'project_bootstrap';
}

export interface MissionTeamCompositionBrief {
  mission_id: string;
  request_summary: string;
  mission_type: string;
  mission_classification: MissionClassification;
  workflow_design: MissionWorkflowDesign;
  review_design: MissionReviewDesign;
  team_plan: MissionTeamPlan;
  recommended_optional_roles: string[];
  missing_inputs: string[];
  rationale: string[];
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
}

function normalizeText(value: string | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function summarizeRequestText(request: string): string {
  const normalized = request.trim().replace(/\s+/g, ' ');
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function inferOptionalRoleHints(request: string): string[] {
  const text = normalizeText(request);
  const hints = new Set<string>();
  if (/(ux|ui|design|experience|デザイン|画面|体験)/u.test(text)) hints.add('experience_designer');
  if (/(strategy|roadmap|go[-\s]?to[-\s]?market|product|企画|戦略)/u.test(text)) hints.add('product_strategist');
  if (/(release|deploy|rollback|runtime|runbook|運用|監視|本番)/u.test(text)) hints.add('operator');
  if (/(slack|chronos|announcement|user update|連絡|通知|報告)/u.test(text)) hints.add('surface_liaison');
  return Array.from(hints);
}

function inferMissingInputs(request: string, artifactPaths: string[] | undefined): string[] {
  const text = normalizeText(request);
  const artifacts = (artifactPaths || []).map((entry) => entry.toLowerCase());
  const missing: string[] = [];

  if (!text) missing.push('request_text');
  if (/(same as|前と同じ|それと同じ|同様に|as before)/u.test(text)) {
    missing.push('reference_context');
  }
  if (/(my voice|自分の声|私の声|voice clone)/u.test(text)) {
    const hasVoiceProfile = artifacts.some((entry) => entry.includes('voice-profile') || entry.includes('voice_profile'));
    if (!hasVoiceProfile) missing.push('voice_profile_id');
  }
  if (/(brand|design system|デザインシステム|ブランド)/u.test(text)) {
    const hasDesignInput = artifacts.some((entry) =>
      entry.includes('design-system') || entry.includes('design_system') || entry.includes('brand-guideline'),
    );
    if (!hasDesignInput) missing.push('design_system_reference');
  }

  return missing;
}

export function loadAuthorityRoleIndex(): Record<string, AuthorityRoleRecord> {
  const index = loadJson<{ authority_roles: Record<string, AuthorityRoleRecord> }>(
    pathResolver.knowledge('public/governance/authority-role-index.json'),
  );
  return index.authority_roles;
}

export function loadTeamRoleIndex(): Record<string, TeamRoleRecord> {
  const index = loadJson<{ team_roles: Record<string, TeamRoleRecord> }>(
    pathResolver.knowledge('public/orchestration/team-role-index.json'),
  );
  return index.team_roles;
}

export function loadAgentProfileIndex(): Record<string, AgentProfileRecord> {
  const index = loadJson<{ agents: Record<string, AgentProfileRecord> }>(
    pathResolver.knowledge('public/orchestration/agent-profile-index.json'),
  );
  return index.agents;
}

export function loadMissionTeamTemplates(): Record<string, MissionTeamTemplate> {
  const index = loadJson<{ templates: Record<string, MissionTeamTemplate> }>(
    pathResolver.knowledge('public/orchestration/mission-team-templates.json'),
  );
  return index.templates;
}

function selectAgentForTeamRole(
  teamRole: string,
  teamRoleRecord: TeamRoleRecord,
  authorityRoles: Record<string, AuthorityRoleRecord>,
  agents: Record<string, AgentProfileRecord>,
): MissionTeamAssignment {
  for (const preferredAgent of teamRoleRecord.preferred_agents) {
    const profile = agents[preferredAgent];
    if (!profile) continue;
    if (!profile.team_roles.includes(teamRole)) continue;
    const authorityRole = profile.authority_roles.find((role) =>
      teamRoleRecord.compatible_authority_roles.includes(role),
    );
    if (!authorityRole) continue;
    const authorityRecord = authorityRoles[authorityRole];
    if (!authorityRecord) continue;
    const requiredScopes = new Set(teamRoleRecord.required_scope_classes || []);
    const resolvedScopes = new Set(authorityRecord.scope_classes || []);
    const missingScope = Array.from(requiredScopes).find((scopeClass) => !resolvedScopes.has(scopeClass));
    if (missingScope) continue;

    return {
      team_role: teamRole,
      required: true,
      status: 'assigned',
      agent_id: preferredAgent,
      authority_role: authorityRole,
      delegation_contract: {
        ownership_scope: teamRoleRecord.ownership_scope,
        allowed_delegate_team_roles: teamRoleRecord.allowed_delegate_team_roles,
        escalation_parent_team_role: teamRoleRecord.escalation_parent_team_role,
        required_scope_classes: teamRoleRecord.required_scope_classes,
        resolved_scope_classes: authorityRecord.scope_classes || [],
        allowed_write_scopes: authorityRecord.write_scopes || [],
      },
      provider: profile.provider,
      modelId: profile.modelId,
      required_capabilities: teamRoleRecord.required_capabilities,
      notes: `${teamRoleRecord.autonomy_level} autonomy; matched via preferred agent profile`,
    };
  }

  return {
    team_role: teamRole,
    required: true,
    status: 'unfilled',
    agent_id: null,
    authority_role: null,
    delegation_contract: null,
    provider: null,
    modelId: null,
    required_capabilities: teamRoleRecord.required_capabilities,
    notes: 'No compatible agent profile found for this team role',
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

export function buildMissionTeamView(plan: MissionTeamPlan): Record<string, string> {
  const view: Record<string, string> = {};
  for (const assignment of plan.assignments) {
    if (assignment.status === 'assigned' && assignment.agent_id) {
      view[assignment.team_role] = assignment.agent_id;
    }
  }
  return view;
}

export function composeMissionTeamBrief(input: MissionTeamCompositionBriefInput): MissionTeamCompositionBrief {
  const missionId = (input.missionId || 'MISSION-BRIEF').toUpperCase();
  const request = String(input.request || '').trim();
  const tier = input.tier || 'public';
  const missionClassification = resolveMissionClassification({
    missionTypeHint: input.missionType,
    intentId: input.intentId,
    taskType: input.taskType,
    shape: input.shape,
    utterance: request,
    artifactPaths: input.artifactPaths,
    progressSignals: input.progressSignals,
  });
  const missionType = input.missionType || mapMissionClassToMissionTypeTemplate(missionClassification.mission_class);
  const teamPlan = composeMissionTeamPlan({
    missionId,
    missionType,
    intentId: input.intentId,
    taskType: input.taskType,
    shape: input.shape,
    utterance: request,
    artifactPaths: input.artifactPaths,
    progressSignals: input.progressSignals,
    tier,
    assignedPersona: input.assignedPersona,
  });
  const workflowDesign = resolveMissionWorkflowDesign({
    missionClass: missionClassification.mission_class,
    deliveryShape: missionClassification.delivery_shape,
    riskProfile: missionClassification.risk_profile,
    stage: missionClassification.stage,
    executionShape: input.executionShape || 'mission',
    intentId: input.intentId,
    taskType: input.taskType,
  });
  const reviewDesign = resolveMissionReviewDesign({
    missionClass: missionClassification.mission_class,
    deliveryShape: missionClassification.delivery_shape,
    riskProfile: missionClassification.risk_profile,
    workflowPattern: workflowDesign.pattern,
    stage: missionClassification.stage,
  });

  const assignedRoles = new Set(teamPlan.assignments.map((entry) => entry.team_role));
  const recommendedOptionalRoles = inferOptionalRoleHints(request).filter((role) => !assignedRoles.has(role));
  const missingInputs = inferMissingInputs(request, input.artifactPaths);

  return {
    mission_id: missionId,
    request_summary: summarizeRequestText(request),
    mission_type: missionType,
    mission_classification: missionClassification,
    workflow_design: workflowDesign,
    review_design: reviewDesign,
    team_plan: teamPlan,
    recommended_optional_roles: recommendedOptionalRoles,
    missing_inputs: missingInputs,
    rationale: [
      `Mission class resolved as ${missionClassification.mission_class} at stage ${missionClassification.stage}.`,
      `Workflow ${workflowDesign.workflow_id} selected for execution shape ${input.executionShape || 'mission'}.`,
      `Review mode ${reviewDesign.review_mode} selected with ${reviewDesign.required_gate_ids.length} required gate(s).`,
    ],
  };
}
