import type { ValidateFunction } from 'ajv';
import { compileSchema, defineCatalog, readJson } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { parseSafeJsonObjectValue } from './json-input.js';

export type TaskTrigger =
  | { type: 'schedule'; cron: string; timezone?: string }
  | { type: 'event'; event_name: string; source?: string; conditions?: string[] }
  | { type: 'manual'; prompt: string };

export type TaskScenario = {
  id: string;
  title: string;
  description: string;
  trigger: TaskTrigger;
  input: { sources: string[]; required_params: string[]; optional_params?: string[] };
  first_run: { reasoning_required: boolean; questions: string[]; profile_output: string };
  repeat_run: { pipeline_template: string; params_from_profile: boolean; profile_input?: string };
  result: { artifacts: string[]; summary_format: 'markdown' | 'json' | 'text' };
  approval_boundary: {
    required_for: string[];
    default_action: 'draft-only' | 'notify-only' | 'requires-human-approval';
  };
};

const TASK_SCENARIO_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/task-scenario.schema.json'
);
function taskScenarioCatalog(filePath: string) {
  return defineCatalog<TaskScenario>({
    id: 'task-scenario',
    path: filePath,
    schema: TASK_SCENARIO_SCHEMA_PATH,
  });
}

let validateTaskScenarioSchema: ValidateFunction | null = null;

function validator(): ValidateFunction {
  validateTaskScenarioSchema ||= compileSchema(TASK_SCENARIO_SCHEMA_PATH);
  return validateTaskScenarioSchema;
}

export function validateTaskScenario(value: unknown): TaskScenario {
  const validate = validator();
  if (!validate(value)) {
    const details = (validate.errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'invalid value'}`)
      .join('; ');
    throw new Error(`Invalid TaskScenario${details ? `: ${details}` : ''}`);
  }
  return value as TaskScenario;
}

export function loadTaskScenario(filePath: string): TaskScenario {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeFilePath) || !safeLstat(safeFilePath).isFile()) {
    throw new Error(`TaskScenario must be a regular file: ${filePath}`);
  }
  return taskScenarioCatalog(safeFilePath).load();
}

export function parseTaskRecord(value: unknown, label: string): Record<string, unknown> {
  return parseSafeJsonObjectValue(value, label);
}

export function loadTaskRecord(filePath: string, label: string): Record<string, unknown> {
  return parseTaskRecord(readJson<unknown>(filePath), label);
}
