/**
 * TypeScript version of the lightweight JSON Schema validation utility.
 *
 * Validates data against schemas in the schemas/ directory without external dependencies.
 * Supports required fields, type constraints, and enum values.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ValidationResult, ValidationError, JsonSchema } from './types.js';
import { safeReadFile } from './secure-io.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const schemasDir: string = path.resolve(currentDir, '../../schemas');
const schemaCache: Record<string, JsonSchema> = {};

export function loadSchema(schemaName: string): JsonSchema {
  if (schemaCache[schemaName]) return schemaCache[schemaName];
  const filePath = path.join(schemasDir, `${schemaName}.schema.json`);
  const schema: JsonSchema = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
  schemaCache[schemaName] = schema;
  return schema;
}

export function validate(data: Record<string, unknown>, schemaName: string): ValidationResult {
  const schema = loadSchema(schemaName);
  const errors: ValidationError[] = [];

  if (schema.required) {
    for (const field of schema.required) {
      if (data[field] === undefined || data[field] === null) {
        errors.push({ field, message: `Required field "${field}" is missing` });
      }
    }
  }

  if (schema.anyOf) {
    const anyOfSatisfied = schema.anyOf.some((candidate) =>
      (candidate.required || []).every((field) => data[field] !== undefined && data[field] !== null),
    );
    if (!anyOfSatisfied) {
      errors.push({ field: 'anyOf', message: 'At least one alternative required field set must be provided' });
    }
  }

  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (data[key] !== undefined && data[key] !== null) {
        if (
          prop.type &&
          typeof data[key] !== prop.type &&
          prop.type !== 'object' &&
          prop.type !== 'array'
        ) {
          errors.push({
            field: key,
            message: `Expected type "${prop.type}", got "${typeof data[key]}"`,
          });
        }
        if (prop.enum && !prop.enum.includes(data[key] as string)) {
          errors.push({
            field: key,
            message: `Value "${String(data[key])}" not in allowed values: ${prop.enum.join(', ')}`,
          });
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateCapabilityInput(data: Record<string, unknown>): ValidationResult {
  return validate(data, 'capability-input');
}

export function validateCapabilityOutput(data: Record<string, unknown>): ValidationResult {
  return validate(data, 'capability-output');
}

export function validateInput(data: Record<string, unknown>): ValidationResult {
  return validateCapabilityInput(data);
}

export function validateOutput(data: Record<string, unknown>): ValidationResult {
  return validateCapabilityOutput(data);
}
