"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadSchema = loadSchema;
exports.validate = validate;
exports.validateInput = validateInput;
exports.validateOutput = validateOutput;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const schemasDir = path.resolve(__dirname, '../../schemas');
/** Schema cache to avoid re-reading files from disk. */
const schemaCache = {};
/**
 * Load a JSON Schema by name from the schemas/ directory.
 *
 * @param schemaName - Schema name without the `.schema.json` extension
 * @returns Parsed JSON Schema object
 * @throws {Error} If the schema file cannot be read or parsed
 */
function loadSchema(schemaName) {
    if (schemaCache[schemaName])
        return schemaCache[schemaName];
    const filePath = path.join(schemasDir, `${schemaName}.schema.json`);
    const schema = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    schemaCache[schemaName] = schema;
    return schema;
}
/**
 * Validate data against a named schema.
 *
 * Checks required fields, type constraints, and enum values.
 *
 * @param data       - Data object to validate
 * @param schemaName - Schema name (e.g. 'skill-input', 'skill-output')
 * @returns Validation result with a `valid` flag and an array of errors
 */
function validate(data, schemaName) {
    const schema = loadSchema(schemaName);
    const errors = [];
    // Check required fields
    if (schema.required) {
        for (const field of schema.required) {
            if (data[field] === undefined || data[field] === null) {
                errors.push({ field, message: `Required field "${field}" is missing` });
            }
        }
    }
    // Check property-level constraints
    if (schema.properties) {
        for (const [key, prop] of Object.entries(schema.properties)) {
            if (data[key] !== undefined && data[key] !== null) {
                // Type check (primitive types only; object/array skipped)
                if (prop.type &&
                    typeof data[key] !== prop.type &&
                    prop.type !== 'object' &&
                    prop.type !== 'array') {
                    errors.push({
                        field: key,
                        message: `Expected type "${prop.type}", got "${typeof data[key]}"`,
                    });
                }
                // Enum check
                if (prop.enum && !prop.enum.includes(data[key])) {
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
/**
 * Validate data against the `skill-input` schema.
 *
 * @param data - Input data to validate
 * @returns Validation result
 */
function validateInput(data) {
    return validate(data, 'skill-input');
}
/**
 * Validate data against the `skill-output` schema.
 *
 * @param data - Output data to validate
 * @returns Validation result
 */
function validateOutput(data) {
    return validate(data, 'skill-output');
}
//# sourceMappingURL=validate.js.map