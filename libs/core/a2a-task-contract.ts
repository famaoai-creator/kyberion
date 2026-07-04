import { A2ATaskContractSchema, formatZodIssues } from './structured-output-contracts.js';
import type { A2ATaskContract } from './channel-surface-types.js';

export interface A2ATaskContractValidationResult {
  valid: boolean;
  errors: string[];
  value?: A2ATaskContract;
}

export function validateA2ATaskContract(value: unknown): A2ATaskContractValidationResult {
  const parsed = A2ATaskContractSchema.safeParse(value);
  return {
    valid: parsed.success,
    errors: parsed.success ? [] : formatZodIssues(parsed.error),
    value: parsed.success ? parsed.data : undefined,
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
