import * as fs from 'node:fs';
/**
 * Secure I/O utilities for Kyberion Ecosystem (TypeScript Edition)
 * Provides file size validation, safe command execution, and resource guards.
 */
export declare const DEFAULT_MAX_FILE_SIZE_MB = 100;
export declare const DEFAULT_TIMEOUT_MS = 30000;
export interface SafeReadOptions {
    maxSizeMB?: number;
    encoding?: BufferEncoding;
    label?: string;
    cache?: boolean;
    timeoutMs?: number;
}
export interface SafeWriteOptions {
    mkdir?: boolean;
    encoding?: BufferEncoding;
    mode?: number;
    flag?: string;
    __sudo?: string;
}
/**
 * Validate that a file does not exceed a size limit.
 */
export declare function validateFileSize(filePath: string, maxSizeMB?: number): number;
/**
 * Read a file with size validation and optional caching.
 */
export declare function safeReadFile(filePath: string, options?: SafeReadOptions): string | Buffer;
/**
 * Write a file safely using atomic operations (write to temp -> rename).
 */
export declare function safeWriteFile(filePath: string, data: string | Buffer, options?: SafeWriteOptions): void;
/**
 * Append to a file safely.
 */
export declare function safeAppendFileSync(filePath: string, data: string | Buffer, options?: any): void;
/**
 * Unlink a file safely.
 */
export declare function safeUnlinkSync(filePath: string): void;
/**
 * Create a directory safely.
 */
export declare function safeMkdir(dirPath: string, options?: fs.MakeDirectoryOptions): void;
/**
 * Check if a file or directory exists safely.
 */
export declare function safeExistsSync(filePath: string): boolean;
/**
 * Execute a command safely.
 */
export declare function safeExec(command: string, args?: string[], options?: any): string;
/**
 * Validate a URL against SSRF and protocol restrictions.
 */
export declare function validateUrl(url: string): string;
/**
 * Sanitize a string for safe use in file paths.
 */
export declare function sanitizePath(input: string): string;
/**
 * Writes an artifact and returns a HAP.
 */
export declare function writeArtifact(filePath: string, data: string | Buffer, format: string): {
    path: string;
    hash: string;
    format: string;
    size_bytes: number;
    timestamp: string;
};
export declare const safeAppendFile: typeof safeAppendFileSync;
export declare const safeUnlink: typeof safeUnlinkSync;
/**
 * Safely read a directory with permission validation.
 */
export declare function safeReaddir(dirPath: string): string[];
/**
 * Safely get file status with permission validation.
 */
export declare function safeStat(filePath: string): fs.Stats;
//# sourceMappingURL=secure-io.d.ts.map