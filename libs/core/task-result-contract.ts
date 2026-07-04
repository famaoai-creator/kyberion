import { TaskResultSchema, formatZodIssues } from './structured-output-contracts.js';
import type { TaskResultBlock } from './channel-surface-types.js';

export interface TaskResultValidationResult {
  valid: boolean;
  errors: string[];
  value?: TaskResultBlock;
}

export function validateTaskResult(value: unknown): TaskResultValidationResult {
  const result = TaskResultSchema.safeParse(value);
  return {
    valid: result.success,
    errors: result.success ? [] : formatZodIssues(result.error),
    value: result.success ? result.data : undefined,
  };
}

export function extractTaskResultBlocks(raw: string): {
  text: string;
  taskResults: TaskResultBlock[];
  taskResultErrors: string[];
} {
  const taskResults: TaskResultBlock[] = [];
  const taskResultErrors: string[] = [];
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
        taskResultErrors.push(`task_result validation failed: ${validation.errors.join('; ')}`);
      }
    } catch (error: any) {
      taskResultErrors.push(`task_result JSON parse failed: ${error?.message ?? String(error)}`);
    }
    return '';
  });

  return { text, taskResults, taskResultErrors };
}
