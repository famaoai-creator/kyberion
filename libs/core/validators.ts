/**
 * TypeScript version of shared input validators for Kyberion components.
 * [SECURE-IO COMPLIANT VERSION]
 */

import * as path from 'node:path';
import * as fs from 'node:fs'; // Still needed for low-level statSync, but we'll minimize it
import { safeReadFile } from './secure-io.js';

/**
 * Validate that a file path exists and points to a regular file.
 */
export function validateFilePath(filePath: string | undefined | null, label = 'input'): string {
  if (!filePath) {
    throw new Error(`Missing required ${label} file path`);
  }
  const resolved = path.resolve(filePath);
  // We use fs.existsSync here because safeReadFile throws if not exists, 
  // but sometimes we just want to validate without reading.
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
 */
export function readJsonFile<T = unknown>(filePath: string, label = 'JSON file'): T {
  const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  return safeJsonParse<T>(content, label);
}

/**
 * Validate that a file is 'fresh' (modified within the last X milliseconds).
 * 
 * @param filePath  - Path to the file
 * @param threshold - Maximum allowed age in milliseconds (default: 1 hour)
 * @throws {Error} If the file is older than the threshold
 */
export function validateFileFreshness(filePath: string, threshold = 60 * 60 * 1000): void {
  const resolved = validateFilePath(filePath);
  const stats = fs.statSync(resolved);
  const age = Date.now() - stats.mtimeMs;

  if (age > threshold) {
    const ageMinutes = Math.round(age / 1000 / 60);
    throw new Error(`STALE_STATE_ERROR: File at ${filePath} was last modified ${ageMinutes} minutes ago (Threshold: ${threshold / 1000 / 60} minutes). Potential cognitive drift detected.`);
  }
}

/**
 * Validate that all required arguments are present in an arguments object.
 */
export function requireArgs(argv: Record<string, unknown>, required: string[]): void {
  const missing = required.filter((name) => argv[name] === undefined || argv[name] === null);
  if (missing.length > 0) {
    throw new Error(`Missing required argument(s): ${missing.join(', ')}`);
  }
}
