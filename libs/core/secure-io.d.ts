import * as fs from 'node:fs';
/**
 * Secure I/O utilities for Gemini Skills (TypeScript Edition)
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
 * Execute a command safely.
 */
export declare function safeExec(command: string, args?: string[], options?: any): string;
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
//# sourceMappingURL=secure-io.d.ts.map