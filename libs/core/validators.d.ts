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
/**
 * Validate that a file path exists and points to a regular file.
 *
 * @param filePath - Path to validate
 * @param label    - Human-readable label for error messages (default: 'input')
 * @returns Resolved absolute path
 * @throws {Error} If the path is missing, not found, or not a regular file
 */
export declare function validateFilePath(
  filePath: string | undefined | null,
  label?: string
): string;
/**
 * Validate that a directory path exists and points to a directory.
 *
 * @param dirPath - Path to validate
 * @param label   - Human-readable label for error messages (default: 'directory')
 * @returns Resolved absolute path
 * @throws {Error} If the path is missing, not found, or not a directory
 */
export declare function validateDirPath(dirPath: string | undefined | null, label?: string): string;
/**
 * Safely parse a JSON string with a descriptive error message on failure.
 *
 * @param jsonString - The string to parse
 * @param label      - Human-readable label for error messages (default: 'JSON')
 * @returns The parsed value
 * @throws {Error} If parsing fails
 */
export declare function safeJsonParse<T = unknown>(jsonString: string, label?: string): T;
/**
 * Read and parse a JSON file safely.
 *
 * @param filePath - Path to the JSON file
 * @param label    - Human-readable label for error messages (default: 'JSON file')
 * @returns Parsed JSON content
 * @throws {Error} If the file cannot be read or the JSON is invalid
 */
export declare function readJsonFile<T = unknown>(filePath: string, label?: string): T;
/**
 * Validate that all required arguments are present in an arguments object.
 *
 * @param argv     - Arguments object (typically from yargs or similar)
 * @param required - List of required argument names
 * @throws {Error} If any required argument is missing (undefined or null)
 */
export declare function requireArgs(argv: Record<string, unknown>, required: string[]): void;
//# sourceMappingURL=validators.d.ts.map
