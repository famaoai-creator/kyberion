import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import * as pathResolver from './path-resolver.js';
import { validateWritePermission, validateReadPermission, detectTier } from './tier-guard.js';
import { policyEngine } from './policy-engine.js';

/**
 * Secure I/O utilities for Kyberion Ecosystem (TypeScript Edition)
 * Provides file size validation, safe command execution, and resource guards.
 */

export const DEFAULT_MAX_FILE_SIZE_MB = 100;
export const DEFAULT_TIMEOUT_MS = 30000;
const SAFE_EXEC_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'PWD',
  'SHLVL',
  'NODE_ENV',
  'NODE_OPTIONS',
  'COREPACK_HOME',
  'PNPM_HOME',
  'NPM_CONFIG_USERCONFIG',
  'NVM_DIR',
  'NVM_BIN',
  'VOLTA_HOME',
  'MISSION_ID',
  'MISSION_ROLE',
  'KYBERION_PERSONA',
  'KYBERION_SUDO',
  'CODEX_HOME',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

export interface SafeReadOptions {
  maxSizeMB?: number;
  encoding?: BufferEncoding | null;
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

export function buildSafeExecEnv(
  extraEnv: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  // Use a string-indexed map locally; Next 15's global augmentation makes
  // `NODE_ENV` a required readonly field on `NodeJS.ProcessEnv`, which is
  // incompatible with constructing the env from scratch. We cast at the
  // boundary instead of polluting every assignment with NODE_ENV.
  const safeEnv: Record<string, string | undefined> = {
    FORCE_COLOR: '0',
    TERM: process.env.TERM || 'dumb',
  };

  for (const key of SAFE_EXEC_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      safeEnv[key] = value;
    }
  }

  for (const [key, value] of Object.entries(extraEnv)) {
    if (value !== undefined) {
      safeEnv[key] = value;
    }
  }

  return safeEnv as NodeJS.ProcessEnv;
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
  if (encoding === null) {
    return fs.readFileSync(resolved);
  }
  return fs.readFileSync(resolved, { encoding });
}

let _policyCheckInProgress = false;

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

  // Policy engine gate (with re-entrancy guard to avoid infinite loop
  // since policyEngine.evaluate -> loadFromFile -> safeReadFile)
  if (!_policyCheckInProgress) {
    _policyCheckInProgress = true;
    try {
      const policyDecision = policyEngine.evaluate({
        agentId: process.env.KYBERION_PERSONA || 'unknown',
        operation: 'file_write',
        target_tier: detectTier(resolved),
        message: `Write to ${resolved}`,
      });
      if (!policyDecision.allowed) {
        throw new Error(`[POLICY_BLOCKED] Write to ${resolved} denied: ${policyDecision.message || 'policy violation'}`);
      }
    } catch (err: any) {
      // Only re-throw if it's an actual policy block, not a load/parse failure
      if (err?.message?.includes('[POLICY_BLOCKED]')) throw err;
      // Policy engine unavailable (no policy file, parse error, etc.) — allow by default
    } finally {
      _policyCheckInProgress = false;
    }
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
 * Copy a file safely with permission validation.
 */
export function safeCopyFileSync(srcPath: string, destPath: string): void {
  const resolvedSrc = pathResolver.resolve(srcPath);
  const resolvedDest = pathResolver.resolve(destPath);
  const readGuard = validateReadPermission(resolvedSrc);
  if (!readGuard.allowed) {
    throw new Error(`[SECURITY] Read access denied to ${srcPath}: ${readGuard.reason}`);
  }
  const writeGuard = validateWritePermission(resolvedDest);
  if (!writeGuard.allowed) {
    throw new Error(writeGuard.reason);
  }
  fs.copyFileSync(resolvedSrc, resolvedDest);
}

/**
 * Move a file or directory safely with permission validation.
 */
export function safeMoveSync(srcPath: string, destPath: string): void {
  const resolvedSrc = pathResolver.resolve(srcPath);
  const resolvedDest = pathResolver.resolve(destPath);
  const readGuard = validateReadPermission(resolvedSrc);
  if (!readGuard.allowed) {
    throw new Error(`[SECURITY] Read access denied to ${srcPath}: ${readGuard.reason}`);
  }
  const sourceWriteGuard = validateWritePermission(resolvedSrc);
  if (!sourceWriteGuard.allowed) {
    throw new Error(sourceWriteGuard.reason);
  }
  const writeGuard = validateWritePermission(resolvedDest);
  if (!writeGuard.allowed) {
    throw new Error(writeGuard.reason);
  }
  fs.renameSync(resolvedSrc, resolvedDest);
}

/**
 * Create a symlink safely with permission validation.
 */
export function safeSymlinkSync(targetPath: string, linkPath: string, type?: fs.symlink.Type): void {
  const resolvedTarget = pathResolver.resolve(targetPath);
  const resolvedLink = pathResolver.resolve(linkPath);
  const targetGuard = validateReadPermission(resolvedTarget);
  if (!targetGuard.allowed) {
    throw new Error(`[SECURITY] Read access denied to ${targetPath}: ${targetGuard.reason}`);
  }
  const linkGuard = validateWritePermission(resolvedLink);
  if (!linkGuard.allowed) {
    throw new Error(linkGuard.reason);
  }
  const dir = path.dirname(resolvedLink);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.symlinkSync(path.relative(dir, resolvedTarget), resolvedLink, type);
}

/**
 * Remove a file or directory safely with permission validation.
 */
export function safeRmSync(targetPath: string, options: fs.RmOptions = { recursive: true, force: true }): void {
  const resolved = pathResolver.resolve(targetPath);
  const guard = validateWritePermission(resolved);
  if (!guard.allowed) throw new Error(guard.reason);
  if (fs.existsSync(resolved)) {
    fs.rmSync(resolved, options);
  }
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
 * Open a file for append safely and return the file descriptor.
 */
export function safeOpenAppendFile(filePath: string): number {
  const resolved = pathResolver.resolve(filePath);
  const guard = validateWritePermission(resolved);
  if (!guard.allowed) throw new Error(guard.reason);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return fs.openSync(resolved, 'a');
}

/**
 * Create a file exclusively. The open is atomic: it fails with EEXIST
 * when another process already owns the path.
 */
export function safeCreateExclusiveFileSync(
  filePath: string,
  data: string | Buffer = '',
): void {
  const resolved = pathResolver.resolve(filePath);
  const guard = validateWritePermission(resolved);
  if (!guard.allowed) throw new Error(guard.reason);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const fd = fs.openSync(resolved, 'wx');
  try {
    if (data.length > 0) fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(resolved); } catch (_) {}
    throw err;
  }
}

/**
 * Safely fsync an existing file for durability.
 */
export function safeFsyncFile(filePath: string): void {
  const resolved = pathResolver.resolve(filePath);
  const guard = validateWritePermission(resolved);
  if (!guard.allowed) throw new Error(guard.reason);
  const fd = fs.openSync(resolved, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Check if a file or directory exists safely.
 */
export function safeExistsSync(filePath: string): boolean {
  if (!filePath) return false;
  const resolved = pathResolver.resolve(filePath);
  return fs.existsSync(resolved);
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
    env = {},
    input,
  } = options;

  return execFileSync(command, args, {
    encoding,
    cwd,
    env: buildSafeExecEnv(env),
    timeout: timeoutMs,
    maxBuffer: maxOutputMB * 1024 * 1024,
    input,
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
    const normalizedHostname = hostname.replace(/^\[(.*)\]$/, '$1');
    const blockedHostnames = ['localhost', '127.0.0.1', '0.0.0.0', '::', '::1'];
    
    if (blockedHostnames.includes(normalizedHostname)) {
      throw new Error(`Blocked URL: ${hostname}`);
    }

    // Basic private IP range detection (IPv4)
    if (/^(10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(normalizedHostname)) {
      throw new Error(`Blocked URL: Private IP range (${hostname})`);
    }

    // IPv6 loopback / link-local / unique-local / IPv4-mapped loopback
    if (
      normalizedHostname.startsWith('fe80:') ||
      normalizedHostname.startsWith('fc') ||
      normalizedHostname.startsWith('fd') ||
      normalizedHostname.startsWith('::ffff:7f00:') ||
      normalizedHostname.startsWith('::ffff:127.')
    ) {
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

/**
 * Safely read a directory with permission validation.
 */
export function safeReaddir(dirPath: string): string[] {
  const resolved = pathResolver.resolve(dirPath);
  const check = validateReadPermission(resolved);
  if (!check.allowed) {
    throw new Error(`[ROLE_VIOLATION] Role is NOT authorized to read directory '${dirPath}'. ${check.reason || ''}`);
  }
  return fs.readdirSync(resolved);
}

/**
 * Safely get file status with permission validation.
 */
export function safeStat(filePath: string): fs.Stats {
  const resolved = pathResolver.resolve(filePath);
  const check = validateReadPermission(resolved);
  if (!check.allowed) {
    throw new Error(`[ROLE_VIOLATION] Role is NOT authorized to stat path '${filePath}'. ${check.reason || ''}`);
  }
  return fs.statSync(resolved);
}

/**
 * Safely get symbolic-link-aware file status with permission validation.
 */
export function safeLstat(filePath: string): fs.Stats {
  const resolved = pathResolver.resolve(filePath);
  const check = validateReadPermission(resolved);
  if (!check.allowed) {
    throw new Error(`[ROLE_VIOLATION] Role is NOT authorized to lstat path '${filePath}'. ${check.reason || ''}`);
  }
  return fs.lstatSync(resolved);
}

/**
 * Safely read a symbolic link target with permission validation.
 */
export function safeReadlink(filePath: string): string {
  const resolved = pathResolver.resolve(filePath);
  const check = validateReadPermission(resolved);
  if (!check.allowed) {
    throw new Error(`[ROLE_VIOLATION] Role is NOT authorized to readlink path '${filePath}'. ${check.reason || ''}`);
  }
  return fs.readlinkSync(resolved);
}
