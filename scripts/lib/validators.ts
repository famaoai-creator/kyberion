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

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Validate that a file path exists and points to a regular file.
 *
 * @param filePath - Path to validate
 * @param label    - Human-readable label for error messages (default: 'input')
 * @returns Resolved absolute path
 * @throws {Error} If the path is missing, not found, or not a regular file
 */
export function validateFilePath(filePath: string | undefined | null, label = 'input'): string {
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
export function validateDirPath(dirPath: string | undefined | null, label = 'directory'): string {
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
export function safeJsonParse<T = unknown>(jsonString: string, label = 'JSON'): T {
  try {
    return JSON.parse(jsonString) as T;
  } catch (err) {
    throw new Error(`Invalid ${label}: ${(err as Error).message}`);
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
export function readJsonFile<T = unknown>(filePath: string, label = 'JSON file'): T {
  const resolved = validateFilePath(filePath, label);
  const content = fs.readFileSync(resolved, 'utf8');
  return safeJsonParse<T>(content, label);
}

/**
 * Validate that all required arguments are present in an arguments object.
 *
 * @param argv     - Arguments object (typically from yargs or similar)
 * @param required - List of required argument names
 * @throws {Error} If any required argument is missing (undefined or null)
 */
export function requireArgs(argv: Record<string, unknown>, required: string[]): void {
  const missing = required.filter((name) => argv[name] === undefined || argv[name] === null);
  if (missing.length > 0) {
    throw new Error(`Missing required argument(s): ${missing.join(', ')}`);
  }
}
