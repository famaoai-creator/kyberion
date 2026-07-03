import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import type { A2ATaskContract } from './channel-surface-types.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const A2A_TASK_CONTRACT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/a2a-task-contract.schema.json'
);

let a2aTaskContractValidateFn: ValidateFunction | null = null;

export interface A2ATaskContractValidationResult {
  valid: boolean;
  errors: string[];
  value?: A2ATaskContract;
}

function ensureA2ATaskContractValidator(): ValidateFunction {
  if (a2aTaskContractValidateFn) return a2aTaskContractValidateFn;
  a2aTaskContractValidateFn = compileSchemaFromPath(ajv, A2A_TASK_CONTRACT_SCHEMA_PATH);
  return a2aTaskContractValidateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

export function validateA2ATaskContract(value: unknown): A2ATaskContractValidationResult {
  const validate = ensureA2ATaskContractValidator();
  const valid = validate(value);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : errorsFrom(validate),
    value: valid ? (value as A2ATaskContract) : undefined,
  };
}

export function isA2ATaskContractLike(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.intent === 'string' ||
    typeof record.objective === 'string' ||
    Array.isArray(record.acceptance_criteria) ||
    Array.isArray(record.expected_outputs) ||
    typeof record.rationale === 'string' ||
    Array.isArray(record.prior_decisions) ||
    (record.context && typeof record.context === 'object')
  );
}
