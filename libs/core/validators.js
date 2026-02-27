'use strict';
/**
 * TypeScript version of shared input validators for Gemini skills.
 *
 * Provides safe file-path validation, JSON parsing, and argument checking.
 *
 * Usage:
 *   import { validateFilePath, safeJsonParse, requireArgs } from '../../scripts/lib/validators.js';
 *   const resolved = validateFilePath(argv.input);
 *   const data = safeJsonParse(rawString, 'headers');
 */
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (!desc || ('get' in desc ? !m.__esModule : desc.writable || desc.configurable)) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k];
            },
          };
        }
        Object.defineProperty(o, k2, desc);
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? function (o, v) {
        Object.defineProperty(o, 'default', { enumerable: true, value: v });
      }
    : function (o, v) {
        o['default'] = v;
      });
var __importStar =
  (this && this.__importStar) ||
  (function () {
    var ownKeys = function (o) {
      ownKeys =
        Object.getOwnPropertyNames ||
        function (o) {
          var ar = [];
          for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
          return ar;
        };
      return ownKeys(o);
    };
    return function (mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null)
        for (var k = ownKeys(mod), i = 0; i < k.length; i++)
          if (k[i] !== 'default') __createBinding(result, mod, k[i]);
      __setModuleDefault(result, mod);
      return result;
    };
  })();
Object.defineProperty(exports, '__esModule', { value: true });
exports.validateFilePath = validateFilePath;
exports.validateDirPath = validateDirPath;
exports.safeJsonParse = safeJsonParse;
exports.readJsonFile = readJsonFile;
exports.requireArgs = requireArgs;
const fs = __importStar(require('node:fs'));
const path = __importStar(require('node:path'));
/**
 * Validate that a file path exists and points to a regular file.
 *
 * @param filePath - Path to validate
 * @param label    - Human-readable label for error messages (default: 'input')
 * @returns Resolved absolute path
 * @throws {Error} If the path is missing, not found, or not a regular file
 */
function validateFilePath(filePath, label = 'input') {
  if (!filePath) {
    throw new Error(`Missing required ${label} file path`);
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`Not a file: ${resolved}`);
  }
  return resolved;
}
/**
 * Validate that a directory path exists and points to a directory.
 *
 * @param dirPath - Path to validate
 * @param label   - Human-readable label for error messages (default: 'directory')
 * @returns Resolved absolute path
 * @throws {Error} If the path is missing, not found, or not a directory
 */
function validateDirPath(dirPath, label = 'directory') {
  if (!dirPath) {
    throw new Error(`Missing required ${label} path`);
  }
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Directory not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
}
/**
 * Safely parse a JSON string with a descriptive error message on failure.
 *
 * @param jsonString - The string to parse
 * @param label      - Human-readable label for error messages (default: 'JSON')
 * @returns The parsed value
 * @throws {Error} If parsing fails
 */
function safeJsonParse(jsonString, label = 'JSON') {
  try {
    return JSON.parse(jsonString);
  } catch (err) {
    throw new Error(`Invalid ${label}: ${err.message}`);
  }
}
/**
 * Read and parse a JSON file safely.
 *
 * @param filePath - Path to the JSON file
 * @param label    - Human-readable label for error messages (default: 'JSON file')
 * @returns Parsed JSON content
 * @throws {Error} If the file cannot be read or the JSON is invalid
 */
function readJsonFile(filePath, label = 'JSON file') {
  const resolved = validateFilePath(filePath, label);
  const content = fs.readFileSync(resolved, 'utf8');
  return safeJsonParse(content, label);
}
/**
 * Validate that all required arguments are present in an arguments object.
 *
 * @param argv     - Arguments object (typically from yargs or similar)
 * @param required - List of required argument names
 * @throws {Error} If any required argument is missing (undefined or null)
 */
function requireArgs(argv, required) {
  const missing = required.filter((name) => argv[name] === undefined || argv[name] === null);
  if (missing.length > 0) {
    throw new Error(`Missing required argument(s): ${missing.join(', ')}`);
  }
}
//# sourceMappingURL=validators.js.map
