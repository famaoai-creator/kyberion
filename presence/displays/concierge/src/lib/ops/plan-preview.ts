import type { UserIntentFlow } from '@agent/core/intent/intent-contract';
import { deriveIntentDeliveryDecision } from '@agent/core/intent/intent-contract';
import {
  composeMissionTeamPlan,
  type MissionTeamPlan,
} from '@agent/core/mission/mission-team-plan-composer';

export interface PlanPreviewRequestContext {
  missionId: string;
  requestText: string;
  tier: 'personal' | 'confidential' | 'public';
  missionType?: string;
  projectId?: string;
  projectName?: string;
  trackId?: string;
  trackName?: string;
  orgRole?: string;
  organizationProfile?: Parameters<typeof composeMissionTeamPlan>[0]['organizationProfile'];
}

export interface PlanPreviewResponse {
  missionId: string;
  requestText: string;
  source: UserIntentFlow['source'];
  confidence: number;
  goal: {
    summary: string;
    successCondition: string;
  };
  delivery: {
    mode: UserIntentFlow['intentContract']['delivery_mode'];
    requiresApproval: boolean;
    clarificationNeeded: boolean;
    askHumanToConfirm: boolean;
    rationale: string;
  };
  execution: {
    shape: UserIntentFlow['intentContract']['resolution']['execution_shape'];
    taskType?: string;
    requiredInputs: string[];
    missingInputs: string[];
    clarificationQuestions: Array<{
      id: string;
      question: string;
      reason: string;
      default_assumption?: string;
      impact?: string;
    }>;
    recommendedNextStep?: string;
  };
  workflow: Array<{
    id: string;
    label: string;
    description: string;
    actuator: string;
    phase: string;
    requires_confirmation?: boolean;
    input_refs?: string[];
    output_refs?: string[];
  }>;
  team: MissionTeamPlan;
}

/**
 * The Org Role of a `POST /api/ops/plan-preview` body. `assignedPersona` is the
 * pre-S4 name, read for one release only when `orgRole` is absent; a present
 * `orgRole` wins.
 */
export function planPreviewOrgRole(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as { orgRole?: unknown; assignedPersona?: unknown };
  const value = record.orgRole !== undefined ? record.orgRole : record.assignedPersona;
  return typeof value === 'string' ? value : undefined;
}

export function buildPlanPreviewSignature(input: {
  requestText: string;
  missionType: string;
  orgRole: string;
  tier: 'personal' | 'confidential' | 'public';
}): string {
  return JSON.stringify({
    requestText: input.requestText.trim(),
    missionType: input.missionType.trim(),
    orgRole: input.orgRole.trim(),
    tier: input.tier,
  });
}

export function isPlanPreviewStale(
  previewSignature: string | null,
  currentSignature: string
): boolean {
  if (!previewSignature) return true;
  return previewSignature !== currentSignature;
}

export function buildPlanPreview(
  input: PlanPreviewRequestContext,
  flow: UserIntentFlow
): PlanPreviewResponse {
  const decision = deriveIntentDeliveryDecision(flow.intentContract);
  const team = composeMissionTeamPlan({
    missionId: input.missionId,
    missionType: input.missionType || flow.intentContract.intent_id,
    tier: input.tier,
    orgRole: input.orgRole,
    organizationProfile: input.organizationProfile || undefined,
  });

  return {
    missionId: input.missionId,
    requestText: input.requestText,
    source: flow.source,
    confidence: flow.intentContract.confidence ?? flow.executionBrief.confidence ?? 0,
    goal: {
      summary: flow.intentContract.goal.summary,
      successCondition: flow.intentContract.goal.success_condition,
    },
    delivery: {
      mode: flow.intentContract.delivery_mode,
      requiresApproval: flow.intentContract.approval.requires_approval,
      clarificationNeeded: flow.intentContract.clarification_needed,
      askHumanToConfirm: decision.askHumanToConfirm,
      rationale: decision.rationale,
    },
    execution: {
      shape: flow.intentContract.resolution.execution_shape,
      taskType: flow.intentContract.resolution.task_type,
      requiredInputs: [...flow.intentContract.required_inputs],
      missingInputs: [...flow.executionBrief.missing_inputs],
      clarificationQuestions: [...(flow.executionBrief.clarification_questions || [])],
      recommendedNextStep: flow.executionBrief.recommended_next_step,
    },
    workflow: [...(flow.executionBrief.workflow_steps || [])].map((step) => ({
      ...step,
    })),
    team,
  };
}
