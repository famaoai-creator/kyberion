import * as nodePath from 'node:path';
import type { PlannedNextTask } from './mission-orchestration-worker-contracts.js';
import { missionClassOf } from './mission-orchestration-phase-gates.js';

export function validatePlannedNextTasks(rawTasks: unknown, missionId: string): PlannedNextTask[] {
  if (!Array.isArray(rawTasks)) {
    throw new Error(`Invalid NEXT_TASKS.json for ${missionId}: expected an array`);
  }

  const taskIds = new Set<string>();
  const tasks = rawTasks.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(
        `Invalid NEXT_TASKS.json for ${missionId}: task ${index + 1} is not an object`
      );
    }
    const task = entry as Record<string, unknown>;
    const taskId = String(task.task_id || '').trim();
    if (!taskId) {
      throw new Error(
        `Invalid NEXT_TASKS.json for ${missionId}: task ${index + 1} is missing task_id`
      );
    }
    if (taskIds.has(taskId)) {
      throw new Error(`Invalid NEXT_TASKS.json for ${missionId}: duplicate task_id ${taskId}`);
    }
    taskIds.add(taskId);

    const dependencies = Array.isArray(task.dependencies)
      ? task.dependencies.map((dependency) => String(dependency || '').trim()).filter(Boolean)
      : [];
    const resourceClaims = (() => {
      if (task.resource_claims === undefined) return [];
      if (!Array.isArray(task.resource_claims)) {
        throw new Error(
          `Invalid NEXT_TASKS.json for ${missionId}: task ${taskId} resource_claims must be an array`
        );
      }
      return Array.from(
        new Set(
          task.resource_claims.map((claim) => {
            if (typeof claim !== 'string' || !claim.trim()) {
              throw new Error(
                `Invalid NEXT_TASKS.json for ${missionId}: task ${taskId} resource_claims must contain non-empty strings`
              );
            }
            return claim.trim();
          })
        )
      );
    })();
    const acceptanceCriteria = Array.isArray(task.acceptance_criteria)
      ? task.acceptance_criteria.map((criterion) => String(criterion || '').trim()).filter(Boolean)
      : [];
    const assignedRole =
      typeof (task.assigned_to as Record<string, unknown> | undefined)?.role === 'string'
        ? String((task.assigned_to as Record<string, unknown>).role || '').trim()
        : '';
    const reviewTarget =
      typeof task.review_target === 'string' && task.review_target.trim()
        ? task.review_target.trim()
        : '';
    const deliverable =
      typeof task.deliverable === 'string' && task.deliverable.trim()
        ? task.deliverable.trim()
        : '';
    if (assignedRole === 'reviewer' || assignedRole === 'qa') {
      if (dependencies.length === 0) {
        throw new Error(
          `Invalid NEXT_TASKS.json for ${missionId}: reviewer task ${taskId} must depend on at least one completed task`
        );
      }
      if (!reviewTarget) {
        throw new Error(
          `Invalid NEXT_TASKS.json for ${missionId}: reviewer task ${taskId} is missing review_target`
        );
      }
      if (!dependencies.includes(reviewTarget)) {
        throw new Error(
          `Invalid NEXT_TASKS.json for ${missionId}: reviewer task ${taskId} must depend on review_target ${reviewTarget}`
        );
      }
      const expectedDeliverable = `REVIEW-${reviewTarget}.md`;
      if (!deliverable || nodePath.basename(deliverable) !== expectedDeliverable) {
        throw new Error(
          `Invalid NEXT_TASKS.json for ${missionId}: reviewer task ${taskId} must use deliverable ${expectedDeliverable}`
        );
      }
    }

    return {
      task_id: taskId,
      ...(typeof task.status === 'string' && task.status.trim()
        ? { status: task.status.trim() }
        : {}),
      ...(typeof task.rework_count === 'number' && Number.isFinite(task.rework_count)
        ? { rework_count: task.rework_count }
        : {}),
      ...(task.assigned_to && typeof task.assigned_to === 'object'
        ? {
            assigned_to: {
              ...(typeof (task.assigned_to as Record<string, unknown>).role === 'string' &&
              String((task.assigned_to as Record<string, unknown>).role || '').trim()
                ? { role: String((task.assigned_to as Record<string, unknown>).role).trim() }
                : {}),
              ...(typeof (task.assigned_to as Record<string, unknown>).agent_id === 'string' &&
              String((task.assigned_to as Record<string, unknown>).agent_id || '').trim()
                ? {
                    agent_id: String((task.assigned_to as Record<string, unknown>).agent_id).trim(),
                  }
                : {}),
            },
          }
        : {}),
      ...(typeof task.description === 'string' && task.description.trim()
        ? { description: task.description.trim() }
        : {}),
      ...(deliverable ? { deliverable } : {}),
      ...(typeof task.target_path === 'string' && task.target_path.trim()
        ? { target_path: task.target_path.trim() }
        : {}),
      dependencies,
      ...(resourceClaims.length > 0 ? { resource_claims: resourceClaims } : {}),
      acceptance_criteria: acceptanceCriteria,
      ...(typeof task.risk === 'string' && task.risk.trim() ? { risk: task.risk.trim() } : {}),
      ...(typeof task.expected_output_format === 'string' && task.expected_output_format.trim()
        ? {
            expected_output_format:
              task.expected_output_format.trim() as PlannedNextTask['expected_output_format'],
          }
        : {}),
      ...(typeof task.estimated_scope === 'string' && task.estimated_scope.trim()
        ? { estimated_scope: task.estimated_scope.trim() as PlannedNextTask['estimated_scope'] }
        : {}),
      ...(typeof task.timeout_ms === 'number' &&
      Number.isFinite(task.timeout_ms) &&
      task.timeout_ms > 0
        ? { timeout_ms: task.timeout_ms }
        : {}),
      ...(reviewTarget ? { review_target: reviewTarget } : {}),
      ...(typeof task.review_round === 'number' && Number.isFinite(task.review_round)
        ? { review_round: task.review_round }
        : {}),
      ...(task.artifact_review_profile && typeof task.artifact_review_profile === 'object'
        ? {
            artifact_review_profile:
              task.artifact_review_profile as PlannedNextTask['artifact_review_profile'],
          }
        : {}),
      ...(typeof task.artifact_review_receipt === 'string' && task.artifact_review_receipt.trim()
        ? { artifact_review_receipt: task.artifact_review_receipt.trim() }
        : {}),
      ...(task.reconciliation && typeof task.reconciliation === 'object'
        ? { reconciliation: task.reconciliation as PlannedNextTask['reconciliation'] }
        : {}),
      ...(task.last_result && typeof task.last_result === 'object'
        ? { last_result: task.last_result as PlannedNextTask['last_result'] }
        : {}),
      ...(Array.isArray(task.review_findings)
        ? {
            review_findings: task.review_findings
              .map((finding) => {
                if (!finding || typeof finding !== 'object') return null;
                const entry = finding as Record<string, unknown>;
                const severity = String(entry.severity || '').trim();
                const location = String(entry.location || '').trim();
                const instruction = String(entry.instruction || '').trim();
                if (
                  (severity !== 'must_fix' && severity !== 'should_fix' && severity !== 'nit') ||
                  !location ||
                  !instruction
                ) {
                  return null;
                }
                return { severity, location, instruction };
              })
              .filter(
                (finding): finding is NonNullable<PlannedNextTask['review_findings']>[number] =>
                  Boolean(finding)
              ),
          }
        : {}),
      ...(task.rework_packet && typeof task.rework_packet === 'object'
        ? {
            rework_packet: {
              from_task: String(
                (task.rework_packet as Record<string, unknown>).from_task || ''
              ).trim(),
              findings: Array.isArray((task.rework_packet as Record<string, unknown>).findings)
                ? ((task.rework_packet as Record<string, unknown>).findings as unknown[])
                    .map((finding) => {
                      if (!finding || typeof finding !== 'object') return null;
                      const entry = finding as Record<string, unknown>;
                      const severity = String(entry.severity || '').trim();
                      const location = String(entry.location || '').trim();
                      const instruction = String(entry.instruction || '').trim();
                      if (
                        (severity !== 'must_fix' &&
                          severity !== 'should_fix' &&
                          severity !== 'nit') ||
                        !location ||
                        !instruction
                      ) {
                        return null;
                      }
                      return { severity, location, instruction };
                    })
                    .filter(
                      (
                        finding
                      ): finding is NonNullable<
                        PlannedNextTask['rework_packet']
                      >['findings'][number] => Boolean(finding)
                    )
                : [],
              round: (() => {
                const rawRound = (task.rework_packet as Record<string, unknown>).round;
                return typeof rawRound === 'number' && Number.isFinite(rawRound) ? rawRound : 0;
              })(),
            },
          }
        : {}),
      // KD-01 adoption: opt-in goal-driven execution (default OFF).
      ...(task.goal_driven === true ? { goal_driven: true } : {}),
      ...(task.goal_budget && typeof task.goal_budget === 'object'
        ? (() => {
            const rawBudget = task.goal_budget as Record<string, unknown>;
            const budget: NonNullable<PlannedNextTask['goal_budget']> = {};
            for (const key of ['tokenBudget', 'turnBudget', 'wallClockBudgetMs'] as const) {
              const value = rawBudget[key];
              if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
                budget[key] = value;
              }
            }
            return Object.keys(budget).length > 0 ? { goal_budget: budget } : {};
          })()
        : {}),
    } satisfies PlannedNextTask;
  });

  const adjacency = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependency of task.dependencies || []) {
      if (!taskIds.has(dependency)) {
        throw new Error(
          `Invalid NEXT_TASKS.json for ${missionId}: task ${task.task_id} depends on missing task ${dependency}`
        );
      }
    }
    adjacency.set(task.task_id, [...(task.dependencies || [])]);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      throw new Error(
        `Invalid NEXT_TASKS.json for ${missionId}: dependency cycle detected at ${taskId}`
      );
    }
    visiting.add(taskId);
    for (const dependency of adjacency.get(taskId) || []) {
      visit(dependency);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) {
    visit(task.task_id);
  }

  // E2E-03 Task 6: code changes are review-mandatory. A code_change mission
  // whose plan has implement work but no reviewer/qa task is a planner
  // contract violation — block before dispatch, not after damage.
  if (missionClassOf(missionId) === 'code_change') {
    const hasImplementWork = tasks.some((task) => {
      const role = String(task.assigned_to?.role || '').toLowerCase();
      return role !== 'reviewer' && role !== 'qa' && role !== 'planner';
    });
    const hasReviewTask = tasks.some((task) => {
      const role = String(task.assigned_to?.role || '').toLowerCase();
      return role === 'reviewer' || role === 'qa';
    });
    if (hasImplementWork && !hasReviewTask) {
      throw new Error(
        `Invalid NEXT_TASKS.json for ${missionId}: code_change missions require at least one reviewer/qa task (planner contract violation)`
      );
    }
  }

  return tasks;
}
