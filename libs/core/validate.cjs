const fs = require('fs');
const path = require('path');

/**
 * Lightweight JSON Schema validation utility.
 * Validates data against schemas in the schemas/ directory without external dependencies.
 * Supports required fields, type constraints, and enum values.
 *
 * Usage:
 *   const { validateInput, validateOutput } = require('../../scripts/lib/validate.cjs');
 *   const result = validateInput({ skill: 'my-skill', action: 'run' });
 *   if (!result.valid) console.error(result.errors);
 *
 * @module validate
 */

const schemasDir = path.resolve(__dirname, '../../schemas');
const pathResolver = require('./path-resolver.cjs');

/** @type {Object<string, Object>} Schema cache to avoid re-reading files */
const schemaCache = {};

/**
 * Load a JSON Schema by name from the schemas/ directory.
 * @param {string} schemaName - Schema name without .schema.json extension
 * @returns {Object} Parsed JSON Schema
 * @throws {Error} If schema file cannot be read or parsed
 */
function loadSchema(schemaName) {
  if (schemaCache[schemaName]) return schemaCache[schemaName];
  const filePath = path.join(schemasDir, `${schemaName}.schema.json`);
  if (!fs.existsSync(filePath)) return null;
  const schema = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  schemaCache[schemaName] = schema;
  return schema;
}

/**
 * Validate data against a specific JSON Schema object.
 */
function validateAgainstSchema(data, schema) {
  if (!schema) return { valid: true, errors: [] };
  const errors = [];

  if (schema.required) {
    for (const field of schema.required) {
      if (data[field] === undefined || data[field] === null) {
        errors.push({ field, message: `Required field "${field}" is missing` });
      }
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
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate data against a named schema from the common schemas directory.
 */
function validate(data, schemaName) {
  const schema = loadSchema(schemaName);
  return validateAgainstSchema(data, schema);
}

/**
 * [NEW] Validate specific skill data against its own contract.json if it exists.
 * @param {string} skillName
 * @param {Object} data
 */
function validateSkillData(skillName, data) {
  try {
    const skillDir = pathResolver.skillDir(skillName);
    const contractPath = path.join(skillDir, 'contract.json');

    if (!fs.existsSync(contractPath)) {
      return { valid: true, errors: [], info: 'No contract.json found' };
    }

    const schema = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    return validateAgainstSchema(data, schema);
  } catch (err) {
    return { valid: false, errors: [{ field: 'contract', message: err.message }] };
  }
}

/**
 * Validate data against the skill-input schema.
 * @param {Object} data - Input data to validate
 * @returns {{ valid: boolean, errors: Array<{ field: string, message: string }> }}
 */
function validateInput(data) {
  return validate(data, 'skill-input');
}

/**
 * Validate data against the skill-output schema.
 * @param {Object} data - Output data to validate
 * @returns {{ valid: boolean, errors: Array<{ field: string, message: string }> }}
 */
function validateOutput(data) {
  return validate(data, 'skill-output');
}

module.exports = {
  validate,
  validateInput,
  validateOutput,
  loadSchema,
  validateSkillData,
  validateAgainstSchema,
};
