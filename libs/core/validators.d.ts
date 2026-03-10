/**
 * TypeScript version of shared input validators for Kyberion components.
 * [SECURE-IO COMPLIANT VERSION]
 */
/**
 * Validate that a file path exists and points to a regular file.
 */
export declare function validateFilePath(filePath: string | undefined | null, label?: string): string;
/**
 * Validate that a directory path exists and points to a directory.
 */
export declare function validateDirPath(dirPath: string | undefined | null, label?: string): string;
/**
 * Safely parse a JSON string with a descriptive error message on failure.
 */
export declare function safeJsonParse<T = unknown>(jsonString: string, label?: string): T;
/**
 * Read and parse a JSON file safely.
 */
export declare function readJsonFile<T = unknown>(filePath: string, label?: string): T;
/**
 * Validate that a file is 'fresh' (modified within the last X milliseconds).
 *
 * @param filePath  - Path to the file
 * @param threshold - Maximum allowed age in milliseconds (default: 1 hour)
 * @throws {Error} If the file is older than the threshold
 */
export declare function validateFileFreshness(filePath: string, threshold?: number): void;
/**
 * Validate that all required arguments are present in an arguments object.
 */
export declare function requireArgs(argv: Record<string, unknown>, required: string[]): void;
//# sourceMappingURL=validators.d.ts.map