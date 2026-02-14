/**
 * TypeScript version of the schema-validator skill.
 *
 * Validates data objects against JSON Schema definitions and reports
 * field-level validation errors.
 *
 * The CLI entry point remains in validate.cjs; this module exports
 * typed helper functions for the core validation logic.
 *
 * Usage:
 *   import { validateAgainstSchema, buildValidationOutput } from './validate.js';
 *   const result = validateAgainstSchema(data, schema);
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillOutput } from '../../scripts/lib/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single field-level validation error. */
export interface ValidationError {
  /** JSON path or field name that failed validation. */
  field: string;
  /** Human-readable error message describing the failure. */
  message: string;
  /** Optional schema keyword that triggered the error (e.g. "type", "required"). */
  keyword?: string;
}

/** Result of schema validation. */
export interface ValidationResult {
  /** Whether the data passed validation. */
  valid: boolean;
  /** Array of validation errors (empty when valid is true). */
  errors: ValidationError[];
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Validate a data object against a JSON Schema.
 *
 * Performs structural validation matching the CJS implementation:
 * - Checks required fields are present
 * - Checks property types match the schema type declarations
 *
 * @param data   - The data object to validate
 * @param schema - The JSON Schema to validate against
 * @returns Validation result with validity flag and any errors
 */
export function validateAgainstSchema(
  data: Record<string, unknown>,
  schema: Record<string, unknown>
): ValidationResult {
  const errors: ValidationError[] = [];
  const required = (schema.required ?? []) as string[];
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;

  // Check required fields
  for (const field of required) {
    if (!(field in data)) {
      errors.push({
        field,
        message: 'Missing required field: ' + field,
        keyword: 'required',
      });
    }
  }

  // Check property types
  for (const [field, propSchema] of Object.entries(properties)) {
    if (!(field in data)) continue;
    const expectedType = propSchema.type as string | undefined;
    if (!expectedType) continue;

    const value = data[field];
    const actualType = Array.isArray(value) ? 'array' : typeof value;

    if (actualType !== expectedType) {
      errors.push({
        field,
        message: `Expected type "${expectedType}" but got "${actualType}"`,
        keyword: 'type',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ---------------------------------------------------------------------------
// SkillOutput builder
// ---------------------------------------------------------------------------

/**
 * Build a SkillOutput envelope for the schema-validator skill.
 *
 * @param result  - Validation result data
 * @param startMs - Start timestamp from Date.now()
 * @returns Standard SkillOutput envelope
 */
export function buildValidationOutput(
  result: ValidationResult,
  startMs: number
): SkillOutput<ValidationResult> {
  return {
    skill: 'schema-validator',
    status: result.valid ? 'success' : 'error',
    data: result,
    metadata: {
      duration_ms: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    },
  };
}
