import type { Ajv, ValidateFunction } from 'ajv';
import { compileSchema } from './foundation/ajv.js';

/**
 * Compatibility boundary for callers that intentionally own an Ajv instance
 * (for example, callers that install ajv-formats or use a custom Ajv draft).
 * New callers should use foundation/ajv.compileSchema(schemaPath).
 */
export function compileSchemaFromPath<T = unknown>(
  ajv: Ajv,
  schemaPath: string
): ValidateFunction<T> {
  return compileSchema<T>(schemaPath, ajv);
}
