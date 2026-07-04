import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import type { TaskResultBlock } from './channel-surface-types.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const TASK_RESULT_SCHEMA_PATH = pathResolver.knowledge('product/schemas/task-result.schema.json');

let taskResultValidateFn: ValidateFunction | null = null;

export interface TaskResultValidationResult {
  valid: boolean;
  errors: string[];
  value?: TaskResultBlock;
}

function ensureTaskResultValidator(): ValidateFunction {
  if (taskResultValidateFn) return taskResultValidateFn;
  taskResultValidateFn = compileSchemaFromPath(ajv, TASK_RESULT_SCHEMA_PATH);
  return taskResultValidateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

export function validateTaskResult(value: unknown): TaskResultValidationResult {
  const validate = ensureTaskResultValidator();
  const valid = validate(value);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : errorsFrom(validate),
    value: valid ? (value as TaskResultBlock) : undefined,
  };
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

  const json = extractJsonObject(text);
  if (json) {
    try {
      const parsed = JSON.parse(json);
      const validation = validateTaskResult(parsed);
      if (validation.valid && validation.value) {
        taskResults.push(validation.value);
      }
    } catch {
      // ignore plain text fallback
    }
  }

  return { text, taskResults, taskResultErrors };
}
