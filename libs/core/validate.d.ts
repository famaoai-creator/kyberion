/**
 * TypeScript version of the lightweight JSON Schema validation utility.
 *
 * Validates data against schemas in the schemas/ directory without external dependencies.
 * Supports required fields, type constraints, and enum values.
 *
 * Usage:
 *   import { validateInput, validateOutput } from '../../scripts/lib/validate.js';
 *   const result = validateInput({ skill: 'my-skill', action: 'run' });
 *   if (!result.valid) console.error(result.errors);
 */
import type { ValidationResult, JsonSchema } from './types.js';
/**
 * Load a JSON Schema by name from the schemas/ directory.
 *
 * @param schemaName - Schema name without the `.schema.json` extension
 * @returns Parsed JSON Schema object
 * @throws {Error} If the schema file cannot be read or parsed
 */
export declare function loadSchema(schemaName: string): JsonSchema;
/**
 * Validate data against a named schema.
 *
 * Checks required fields, type constraints, and enum values.
 *
 * @param data       - Data object to validate
 * @param schemaName - Schema name (e.g. 'skill-input', 'skill-output')
 * @returns Validation result with a `valid` flag and an array of errors
 */
export declare function validate(data: Record<string, unknown>, schemaName: string): ValidationResult;
/**
 * Validate data against the `skill-input` schema.
 *
 * @param data - Input data to validate
 * @returns Validation result
 */
export declare function validateInput(data: Record<string, unknown>): ValidationResult;
/**
 * Validate data against the `skill-output` schema.
 *
 * @param data - Output data to validate
 * @returns Validation result
 */
export declare function validateOutput(data: Record<string, unknown>): ValidationResult;
//# sourceMappingURL=validate.d.ts.map