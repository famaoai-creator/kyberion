import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import * as pathResolver from './path-resolver.js';
import { validateWritePermission, validateReadPermission } from './tier-guard.js';

/**
 * Secure I/O utilities for Kyberion Ecosystem (TypeScript Edition)
 * Provides file size validation, safe command execution, and resource guards.
 */

export const DEFAULT_MAX_FILE_SIZE_MB = 100;
export const DEFAULT_TIMEOUT_MS = 30000;

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
export function validateFileSize(filePath: string, maxSizeMB = DEFAULT_MAX_FILE_SIZE_MB): number {
  const resolved = pathResolver.resolve(filePath);
  const stat = fs.statSync(resolved);
  const sizeMB = stat.size / (1024 * 1024);
  if (sizeMB > maxSizeMB) {
    throw new Error(
      `File too large: ${resolved} is ${sizeMB.toFixed(1)}MB (limit: ${maxSizeMB}MB)`
    );
  }
  return stat.size;
}

/**
 * Read a file with size validation and optional caching.
 */
export function safeReadFile(filePath: string, options: SafeReadOptions = {}): string | Buffer {
  const {
    maxSizeMB = DEFAULT_MAX_FILE_SIZE_MB,
    encoding = 'utf8',
    label = 'input',
    cache = true,
  } = options;

  if (!filePath) {
    throw new Error(`Missing required ${label} file path`);
  }

  const resolved = pathResolver.resolve(filePath);
  const guard = validateReadPermission(resolved);
  if (!guard.allowed) {
    throw new Error(`[SECURITY] Read access denied to ${filePath}: ${guard.reason}`);
  }

  // Fallback for non-cached or missing
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  validateFileSize(resolved, maxSizeMB);
  return fs.readFileSync(resolved, { encoding });
}

/**
 * Write a file safely using atomic operations (write to temp -> rename).
 */
export function safeWriteFile(filePath: string, data: string | Buffer, options: SafeWriteOptions = {}): void {
  const { mkdir = true } = options;
  const resolved = pathResolver.resolve(filePath);

  const guard = validateWritePermission(resolved);
  if (!guard.allowed) {
    throw new Error(guard.reason);
  }

  const dir = path.dirname(resolved);
  if (mkdir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const ns = process.hrtime.bigint().toString();
  const tempPath = `${resolved}.tmp.${ns}.${Math.random().toString(36).substring(2)}`;

  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, 'w');
    fs.writeFileSync(fd, data, options as any);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, resolved);
  } catch (err) {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
    if (fs.existsSync(tempPath)) try { fs.unlinkSync(tempPath); } catch (_) {}
    throw err;
  }
}

/**
 * Append to a file safely.
 */
export function safeAppendFileSync(filePath: string, data: string | Buffer, options: any = 'utf8'): void {
  const resolved = pathResolver.resolve(filePath);
  const guard = validateWritePermission(resolved);
  if (!guard.allowed) throw new Error(guard.reason);
  fs.appendFileSync(resolved, data, options);
}

/**
 * Unlink a file safely.
 */
export function safeUnlinkSync(filePath: string): void {
  const resolved = pathResolver.resolve(filePath);
  const guard = validateWritePermission(resolved);
  if (!guard.allowed) throw new Error(guard.reason);
  if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
}

/**
 * Create a directory safely.
 */
export function safeMkdir(dirPath: string, options: fs.MakeDirectoryOptions = { recursive: true }): void {
  const resolved = pathResolver.resolve(dirPath);
  const guard = validateWritePermission(resolved);
  if (!guard.allowed) throw new Error(guard.reason);
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, options);
  }
}

/**
 * Execute a command safely.
 */
export function safeExec(command: string, args: string[] = [], options: any = {}): string {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cwd = process.cwd(),
    encoding = 'utf8',
    maxOutputMB = 10,
    env = process.env, // Default to current process env
  } = options;

  return execFileSync(command, args, {
    encoding,
    cwd,
    env, // Pass environment variables to child process
    timeout: timeoutMs,
    maxBuffer: maxOutputMB * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as string;
}

/**
 * Validate a URL against SSRF and protocol restrictions.
 */
export function validateUrl(url: string): string {
  if (!url) {
    throw new Error('Missing or invalid URL');
  }

  try {
    const parsed = new URL(url);
    
    // Protocol whitelist
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported protocol: ${parsed.protocol}`);
    }

    // SSRF protection: Block private IP ranges and localhost
    const hostname = parsed.hostname.toLowerCase();
    const blockedHostnames = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
    
    if (blockedHostnames.includes(hostname)) {
      throw new Error(`Blocked URL: ${hostname}`);
    }

    // Basic private IP range detection (IPv4)
    if (/^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(hostname)) {
      throw new Error(`Blocked URL: Private IP range (${hostname})`);
    }

    return url;
  } catch (err: any) {
    if (err.message.includes('Blocked URL') || err.message.includes('Unsupported protocol')) {
      throw err;
    }
    throw new Error(`Invalid URL: ${url}`);
  }
}

/**
 * Sanitize a string for safe use in file paths.
 */
export function sanitizePath(input: string): string {
  if (!input || typeof input !== 'string') return '';
  return input
    .replace(/\0/g, '')
    .replace(/\.\.\//g, '')
    .replace(/\.\.\\/g, '')
    .replace(/^[/\\]+/, '');
}

/**
 * Writes an artifact and returns a HAP.
 */
export function writeArtifact(filePath: string, data: string | Buffer, format: string) {
  const hash = createHash('sha256').update(data).digest('hex');
  safeWriteFile(filePath, data);
  return {
    path: filePath,
    hash,
    format,
    size_bytes: data.length,
    timestamp: new Date().toISOString(),
  };
}

// Alias for compatibility
export const safeAppendFile = safeAppendFileSync;
export const safeUnlink = safeUnlinkSync;
