/**
 * TypeScript version of the lightweight JSON Schema validation utility.
 *
 * Validates data against schemas in the knowledge/product/schemas/ directory without external dependencies.
 * Supports required fields, type constraints, and enum values.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ValidationResult, ValidationError, JsonSchema } from './types.js';
import { readJson } from './foundation/json.js';
import { parseSafeJsonObjectValue } from './foundation/safe-json.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const schemasDir: string = path.resolve(currentDir, '../../knowledge/product/schemas');
const schemaCache = new Map<string, JsonSchema>();

export function loadSchema(schemaName: string): JsonSchema {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(schemaName)) {
    throw new Error(
      `[SCHEMA_INVALID] schema name must be a single filename segment: ${schemaName}`
    );
  }
  const cached = schemaCache.get(schemaName);
  if (cached) return cached;
  const filePath = assertSafeRepositoryPath(path.join(schemasDir, `${schemaName}.schema.json`), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(filePath)) {
    throw new Error(`[SCHEMA_NOT_FOUND] schema not found: ${schemaName}`);
  }
  if (!safeLstat(filePath).isFile()) {
    throw new Error(`[SCHEMA_INVALID] schema must be a regular file: ${schemaName}`);
  }
  const schema = parseSchemaDocument(readJson<unknown>(filePath), schemaName);
  schemaCache.set(schemaName, schema);
  return schema;
}

export function parseSchemaDocument(value: unknown, schemaName = 'schema'): JsonSchema {
  return parseSafeJsonObjectValue(value, `${schemaName} schema`);
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
      (candidate.required || []).every((field) => data[field] !== undefined && data[field] !== null)
    );
    if (!anyOfSatisfied) {
      errors.push({
        field: 'anyOf',
        message: 'At least one alternative required field set must be provided',
      });
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
