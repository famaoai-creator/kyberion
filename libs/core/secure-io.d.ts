import { Readable, Writable } from 'stream';

export const DEFAULT_MAX_FILE_SIZE_MB: number;
export const DEFAULT_TIMEOUT_MS: number;

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
}

export interface SafeExecOptions {
  timeoutMs?: number;
  cwd?: string;
  encoding?: BufferEncoding;
  maxOutputMB?: number;
}

export interface SafeSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: string | null;
}

/**
 * Validate that a file does not exceed a size limit.
 */
export function validateFileSize(filePath: string, maxSizeMB?: number): number;

/**
 * Read a file with size validation and optional caching.
 */
export function safeReadFile(filePath: string, options?: SafeReadOptions): string | Buffer;

/**
 * Read a file asynchronously with size validation and caching.
 */
export function safeReadFileAsync(
  filePath: string,
  options?: SafeReadOptions
): Promise<string | Buffer>;

/**
 * Write a file safely using atomic operations (write to temp -> rename).
 */
export function safeWriteFile(
  filePath: string,
  data: string | Buffer,
  options?: SafeWriteOptions
): void;

/**
 * Append to a file safely with role-based write control.
 */
export function safeAppendFileSync(
  filePath: string,
  data: string | Buffer,
  encoding?: BufferEncoding
): void;

/**
 * Unlink a file safely with role-based write control.
 */
export function safeUnlinkSync(filePath: string): void;

/**
 * Safely pipe streams with error handling and cleanup.
 */
export function safeStreamPipeline(source: Readable, destination: Writable): Promise<void>;

/**
 * Execute a command safely using execFileSync (no shell interpolation).
 */
export function safeExec(command: string, args?: string[], options?: SafeExecOptions): string;

/**
 * Execute a command safely using spawnSync with output streaming.
 */
export function safeSpawn(
  command: string,
  args?: string[],
  options?: SafeExecOptions
): SafeSpawnResult;

/**
 * Sanitize a string for safe use in file paths.
 */
export function sanitizePath(input: string): string;

/**
 * Validate a URL for safe fetching.
 */
export function validateUrl(url: string): string;
