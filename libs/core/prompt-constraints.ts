export type ValidatorName = 'json' | 'json-object' | 'json-array';

export const JSON_OUTPUT_CONSTRAINTS = [
  'Return only valid JSON.',
  'Do not include markdown fences, comments, prose, or trailing commas.',
  'Use double-quoted JSON strings and object keys.',
].join('\n');

export const JSON_OBJECT_CONSTRAINTS = [
  JSON_OUTPUT_CONSTRAINTS,
  'The top-level value must be a JSON object.',
].join('\n');

export const JSON_ARRAY_CONSTRAINTS = [
  JSON_OUTPUT_CONSTRAINTS,
  'The top-level value must be a JSON array.',
].join('\n');

export const VALIDATOR_CHAIN_PATTERN = 'generate -> parse -> repair-json-if-safe -> schema-validate';

export function jsonOutputConstraints(validator: ValidatorName = 'json'): string {
  if (validator === 'json-object') return JSON_OBJECT_CONSTRAINTS;
  if (validator === 'json-array') return JSON_ARRAY_CONSTRAINTS;
  return JSON_OUTPUT_CONSTRAINTS;
}
