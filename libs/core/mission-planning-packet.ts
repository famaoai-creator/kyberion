import * as nodePath from 'node:path';
import type { PlanningPacket } from './channel-surface.js';
import type { MissionTeamPlan } from './mission-team-plan-composer.js';
import {
  PlanningReviewVerdictSchema,
  renderStructuredOutputSchemaPrompt,
} from './structured-output-contracts.js';
import { readJson } from './foundation/json.js';
import { findMissionPath, missionDir } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync } from './secure-io.js';

function safeMissionArtifactPath(missionId: string, relativePath: string): string {
  const missionPath = assertSafeRepositoryPath(
    findMissionPath(missionId) || missionDir(missionId, 'public'),
    { allowMissingLeaf: true }
  );
  return assertSafeRepositoryPath(nodePath.join(missionPath, relativePath), {
    allowMissingLeaf: true,
  });
}

export interface PlannerSourcePayload {
  sourceText?: string;
}

export interface PlanningReviewVerdict {
  raw_text: string;
  parsed?: Record<string, unknown>;
  approve: boolean;
  gaps: string[];
  rationale?: string;
}

/**
 * Read the process-template tasks that form the fixed planning skeleton.
 * The worker may add tasks around these entries, but must not replace them.
 */
export function readProcessTemplateSeededTasks(
  nextTasksPath: string
): Array<Record<string, unknown>> {
  let safeNextTasksPath: string;
  try {
    safeNextTasksPath = assertSafeRepositoryPath(nextTasksPath, { allowMissingLeaf: true });
  } catch {
    return [];
  }
  if (!safeExistsSync(safeNextTasksPath)) return [];
  try {
    const parsed = readJson<unknown>(safeNextTasksPath);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (task): task is Record<string, unknown> =>
        Boolean(task) && typeof task === 'object' && task.origin === 'process_template'
    );
  } catch {
    return [];
  }
}

/**
 * Render the mission process-template skeleton into the planner kickoff
 * prompt. Seeded tasks are fixed and must remain in the resulting plan.
 */
export function renderProcessTemplateSkeleton(missionId: string): string {
  const statePath = safeMissionArtifactPath(missionId, 'mission-state.json');
  if (!safeExistsSync(statePath)) return '';
  let processTemplate: { workflow_id?: string; phases?: string[] } | undefined;
  try {
    const state = readJson<{
      process_template?: { workflow_id?: string; phases?: string[] };
    }>(statePath);
    processTemplate = state.process_template;
  } catch {
    return '';
  }
  if (!processTemplate?.workflow_id) return '';

  const lines = [
    `Process template: ${processTemplate.workflow_id} — phases: ${(processTemplate.phases || []).join(' → ')}.`,
  ];
  const seeded = readProcessTemplateSeededTasks(
    safeMissionArtifactPath(missionId, 'NEXT_TASKS.json')
  );
  if (seeded.length > 0) {
    lines.push(
      'The following tasks were seeded from the process template and are FIXED — do not drop, rename, or restructure them. Plan additional tasks around them and reference their task_ids in dependencies where appropriate:'
    );
    for (const task of seeded) {
      lines.push(`- ${String(task.task_id)} (phase: ${String(task.phase || 'n/a')})`);
    }
  }
  return lines.join('\n');
}

export function buildPlannerKickoffPrompt(
  missionId: string,
  plan: Pick<MissionTeamPlan, 'mission_id' | 'mission_type'>,
  payload: PlannerSourcePayload,
  teamView: Record<string, unknown>,
  validationFeedback?: string[]
): string {
  const sections = [
    `Kick off planning for mission ${missionId}.`,
    `Mission type: ${plan.mission_type}.`,
    `Original source request: ${payload.sourceText || ''}`,
    'Create the initial plan, define deliverables, and prepare the next delegated tasks.',
    renderProcessTemplateSkeleton(missionId),
    'Return exactly one ```planning_packet``` block and no other structured block for the plan.',
    'The planning packet must match this contract:',
    renderStructuredOutputSchemaPrompt('planning_packet'),
    validationFeedback && validationFeedback.length > 0
      ? `Previous response failed validation:\n- ${validationFeedback.join('\n- ')}`
      : '',
    '',
    'Mission team context:',
    JSON.stringify(
      {
        mission_id: plan.mission_id,
        mission_type: plan.mission_type,
        team: teamView,
      },
      null,
      2
    ),
  ].filter(Boolean);

  return sections.join('\n');
}

export function buildPlannerRetryPrompt(
  missionId: string,
  validationErrors: string[],
  previousResponseText: string
): string {
  return [
    `The previous planning response for mission ${missionId} was rejected.`,
    'Return the same mission planning answer again, but fix the contract violations below.',
    'Return exactly one ```planning_packet``` block and nothing else that is structured.',
    `Schema: ${renderStructuredOutputSchemaPrompt('planning_packet')}`,
    'Contract violations:',
    ...validationErrors.map((error) => `- ${error}`),
    '',
    'Previous response excerpt:',
    previousResponseText.slice(0, 1200),
  ].join('\n');
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  const content = fenced ? fenced[1].trim() : trimmed;
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return content.slice(start, end + 1);
}

export function parsePlanningReviewVerdict(text: string): PlanningReviewVerdict {
  const rawText = String(text || '');
  const json = extractJsonObject(rawText);
  let parsed: Record<string, unknown> | undefined;
  let approve = false;
  let gaps: string[] = [];
  let rationale: string | undefined;

  if (json) {
    try {
      const candidate = JSON.parse(json) as unknown;
      const result = PlanningReviewVerdictSchema.safeParse(candidate);
      if (result.success) {
        parsed = candidate as Record<string, unknown>;
        approve = result.data.approve;
        gaps = result.data.gaps;
        rationale = result.data.rationale;
      } else {
        gaps = result.error.issues.map((issue) => {
          const path = issue.path.length > 0 ? `/${issue.path.map(String).join('/')}` : '/';
          return `${path} ${issue.message || 'schema violation'}`.trim();
        });
      }
    } catch {
      gaps = ['planning review verdict was not valid JSON'];
    }
  }

  if (!json) {
    gaps = ['planning review verdict block missing'];
  }

  return {
    approve,
    gaps,
    ...(rationale ? { rationale } : {}),
    raw_text: rawText,
    ...(parsed ? { parsed } : {}),
  };
}

export function packetRequiresIndependentReview(packet: PlanningPacket): boolean {
  return packet.next_tasks.some(
    (task) => task.risk === 'approval_required' || task.risk === 'high_stakes'
  );
}

export function buildPlanningReviewPrompt(input: {
  missionId: string;
  plan: Pick<MissionTeamPlan, 'mission_id' | 'mission_type'>;
  payload: PlannerSourcePayload;
  teamView: Record<string, unknown>;
  packet: PlanningPacket;
  plannerFeedback?: string[];
}): string {
  const highRiskTasks = input.packet.next_tasks.filter(
    (task) => task.risk === 'approval_required' || task.risk === 'high_stakes'
  );
  const sections = [
    `Review the planning packet for mission ${input.missionId}.`,
    'You are an independent reviewer in a separate context from the planner.',
    `Return JSON only. Schema: ${renderStructuredOutputSchemaPrompt('planning_review_verdict')}`,
    'Approve only if the plan can reach the deliverable with no missing dependencies, verification, or high-risk gaps.',
    '',
    'Mission request:',
    input.payload.sourceText || '',
    '',
    'Mission team context:',
    JSON.stringify(
      {
        mission_id: input.plan.mission_id,
        mission_type: input.plan.mission_type,
        team: input.teamView,
      },
      null,
      2
    ),
    '',
    'Planning packet to review:',
    JSON.stringify(input.packet, null, 2),
    highRiskTasks.length > 0
      ? `High-risk tasks requiring independent approval:\n- ${highRiskTasks.map((task) => `${task.task_id}: ${task.description}`).join('\n- ')}`
      : '',
    input.plannerFeedback && input.plannerFeedback.length > 0
      ? `Planner revision guidance:\n- ${input.plannerFeedback.join('\n- ')}`
      : '',
  ].filter(Boolean);
  return sections.join('\n');
}

/**
 * Validate packet-local rules that can be repaired by asking the planner once
 * more. Cross-task dependency rules remain in the worker's persisted-state
 * validation because they depend on the merged on-disk task board.
 */
export function collectPlanningPacketTaskContractErrors(
  missionId: string,
  packet: PlanningPacket
): string[] {
  const packetTasks = Array.isArray(packet.next_tasks) ? packet.next_tasks : [];
  const errors: string[] = [];
  const seenIds = new Set<string>();
  packetTasks.forEach((entry, index) => {
    const task = entry as unknown as Record<string, unknown>;
    const taskId = String(task?.task_id ?? '').trim();
    if (!taskId) {
      errors.push(`task ${index + 1} is missing task_id`);
      return;
    }
    if (seenIds.has(taskId)) {
      errors.push(`duplicate task_id ${taskId}`);
      return;
    }
    seenIds.add(taskId);

    const assignedRole =
      typeof (task.assigned_to as Record<string, unknown> | undefined)?.role === 'string'
        ? String((task.assigned_to as Record<string, unknown>).role || '').trim()
        : '';
    if (assignedRole !== 'reviewer' && assignedRole !== 'qa') return;

    const dependencies = Array.isArray(task.dependencies)
      ? task.dependencies.map((dependency) => String(dependency || '').trim()).filter(Boolean)
      : [];
    const reviewTarget =
      typeof task.review_target === 'string' && task.review_target.trim()
        ? task.review_target.trim()
        : '';
    const deliverable =
      typeof task.deliverable === 'string' && task.deliverable.trim()
        ? task.deliverable.trim()
        : '';
    if (dependencies.length === 0) {
      errors.push(`reviewer task ${taskId} must depend on at least one completed task`);
    }
    if (!reviewTarget) {
      errors.push(`reviewer task ${taskId} is missing review_target`);
    } else if (!dependencies.includes(reviewTarget)) {
      errors.push(`reviewer task ${taskId} must depend on review_target ${reviewTarget}`);
    }
    if (reviewTarget) {
      const expectedDeliverable = `REVIEW-${reviewTarget}.md`;
      if (!deliverable || nodePath.basename(deliverable) !== expectedDeliverable) {
        errors.push(`reviewer task ${taskId} must use deliverable ${expectedDeliverable}`);
      }
    }
  });
  return errors.map((message) => `Planning packet for ${missionId}: ${message}`);
}
