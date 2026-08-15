import { TaskResultSchema, formatZodIssues } from './structured-output-contracts.js';
import type { TaskResultBlock } from './channel-surface-types.js';

export interface TaskResultValidationResult {
  valid: boolean;
  errors: string[];
  value?: TaskResultBlock;
}

export interface TaskResultRepairResult {
  value?: TaskResultBlock;
  repairs: string[];
  requiresReview: boolean;
}

export function validateTaskResult(value: unknown): TaskResultValidationResult {
  const result = TaskResultSchema.safeParse(value);
  return {
    valid: result.success,
    errors: result.success ? [] : formatZodIssues(result.error),
    value: result.success ? result.data : undefined,
  };
}

/** Apply only conservative repairs; never turn uncertain evidence into a pass. */
export function repairTaskResult(value: unknown): TaskResultRepairResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { repairs: [], requiresReview: false };
  }

  const candidate = { ...(value as Record<string, unknown>) };
  const repairs: string[] = [];
  let requiresReview = false;
  if (typeof candidate.summary === 'string' && candidate.summary.length > 800) {
    candidate.summary = `${candidate.summary.slice(0, 797).trimEnd()}...`;
    repairs.push('summary truncated to the 800-character contract limit');
  }
  if (Array.isArray(candidate.acceptance_evidence)) {
    candidate.acceptance_evidence = candidate.acceptance_evidence.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const current = entry as Record<string, unknown>;
      if (current.status === 'passed' || current.status === 'failed') return entry;
      repairs.push('semantic: invalid acceptance_evidence status normalized to failed');
      requiresReview = true;
      return { ...current, status: 'failed' };
    });
  }
  const validation = validateTaskResult(candidate);
  return validation.valid && validation.value
    ? { value: validation.value, repairs, requiresReview }
    : { repairs, requiresReview };
}

export function extractTaskResultBlocks(raw: string): {
  text: string;
  taskResults: TaskResultBlock[];
  taskResultErrors: string[];
  taskResultRepairs: string[];
  taskResultRepairRequiresReview: boolean;
} {
  const taskResults: TaskResultBlock[] = [];
  const taskResultErrors: string[] = [];
  const taskResultRepairs: string[] = [];
  let taskResultRepairRequiresReview = false;
  let text = raw;

  text = text.replace(/```task_result\s*\n([\s\S]*?)```/g, (_match, json) => {
    const trimmed = String(json).trim();
    if (!trimmed) {
      taskResultErrors.push('task_result block was empty');
      return '';
    }

    try {
      const parsed = JSON.parse(trimmed);
      const validation = validateTaskResult(parsed);
      if (validation.valid && validation.value) {
        taskResults.push(validation.value);
      } else {
        const repaired = repairTaskResult(parsed);
        if (repaired.value) {
          taskResults.push(repaired.value);
          taskResultRepairs.push(...repaired.repairs);
          taskResultRepairRequiresReview ||= repaired.requiresReview;
        } else {
          taskResultErrors.push(`task_result validation failed: ${validation.errors.join('; ')}`);
        }
      }
    } catch (error: any) {
      taskResultErrors.push(`task_result JSON parse failed: ${error?.message ?? String(error)}`);
    }
    return '';
  });

  return {
    text,
    taskResults,
    taskResultErrors,
    taskResultRepairs,
    taskResultRepairRequiresReview,
  };
}
