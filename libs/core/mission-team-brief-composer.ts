import * as path from 'node:path';
import {
  mapMissionClassToMissionTypeTemplate,
  resolveMissionClassification,
  type MissionClassification,
} from './mission-classification.js';
import {
  resolveMissionWorkflowDesign,
  type MissionWorkflowDesign,
} from './mission-workflow-catalog.js';
import { resolveMissionReviewDesign, type MissionReviewDesign } from './mission-review-gates.js';
import { composeMissionTeamPlan, type MissionTeamPlan } from './mission-team-plan-composer.js';
import { type OrganizationProfile } from './organization-profile.js';
import {
  inferMissingInputs,
  inferOptionalRoleHints,
  summarizeRequestText,
} from './mission-team-brief-utils.js';
import { safeWriteFile, safeExistsSync, safeMkdir } from './secure-io.js';

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
  organizationProfile?: OrganizationProfile | null;
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
  team_governance: MissionTeamPlan['team_governance'];
  recommended_optional_roles: string[];
  missing_inputs: string[];
  rationale: string[];
}

/**
 * Persist a composed brief to the mission's evidence directory.
 * Returns the path of the written file.
 */
export function writeMissionTeamBrief(
  missionPath: string,
  brief: MissionTeamCompositionBrief
): string {
  const evidenceDir = path.join(missionPath, 'evidence');
  if (!safeExistsSync(evidenceDir)) safeMkdir(evidenceDir, { recursive: true });
  const targetPath = path.join(evidenceDir, 'team-composition-brief.json');
  safeWriteFile(targetPath, JSON.stringify(brief, null, 2));
  return targetPath;
}

export function composeMissionTeamBrief(
  input: MissionTeamCompositionBriefInput
): MissionTeamCompositionBrief {
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
  const missionType =
    input.missionType || mapMissionClassToMissionTypeTemplate(missionClassification.mission_class);
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
    organizationProfile: input.organizationProfile,
  });
  const workflowDesign = resolveMissionWorkflowDesign({
    missionClass: missionClassification.mission_class,
    deliveryShape: missionClassification.delivery_shape,
    riskProfile: missionClassification.risk_profile,
    stage: missionClassification.stage,
    executionShape: input.executionShape || 'mission',
    missionTypeHint: input.missionType,
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
  const recommendedOptionalRoles = inferOptionalRoleHints(request).filter(
    (role) => !assignedRoles.has(role)
  );
  const missingInputs = inferMissingInputs(request, input.artifactPaths);

  return {
    mission_id: missionId,
    request_summary: summarizeRequestText(request),
    mission_type: missionType,
    mission_classification: missionClassification,
    workflow_design: workflowDesign,
    review_design: reviewDesign,
    team_plan: teamPlan,
    team_governance: teamPlan.team_governance,
    recommended_optional_roles: recommendedOptionalRoles,
    missing_inputs: missingInputs,
    rationale: [
      `Mission class resolved as ${missionClassification.mission_class} at stage ${missionClassification.stage}.`,
      `Workflow ${workflowDesign.workflow_id} selected for execution shape ${input.executionShape || 'mission'}.`,
      `Review mode ${reviewDesign.review_mode} selected with ${reviewDesign.required_gate_ids.length} required gate(s).`,
    ],
  };
}
