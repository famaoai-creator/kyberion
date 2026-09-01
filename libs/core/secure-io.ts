import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import * as pathResolver from './path-resolver.js';
import {
  getRegisteredEnvBool,
  getRegisteredEnvText,
  registerEnvironmentRegistryReader,
} from './foundation/env.js';
import { assertSensitivePathAllowed, assertSensitiveTextAllowed } from './sensitive-path-policy.js';
import { assertSandboxNetworkAllowed } from './sandbox-policy.js';
import { registerFoundationIo } from './foundation/io.js';
import { validateWritePermission, validateReadPermission, detectTier } from './tier-guard.js';
import { policyEngine } from './policy-engine.js';
import * as auditChainModule from './audit-chain.js';
import { recordGovernanceAction } from './governance-action-recorder.js';
import { createLogger } from './logger.js';

const logger = createLogger('secure-io');
const auditChain = auditChainModule.auditChain;

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
  'CI',
  'PNPM_CONFIG_CONFIRM_MODULES_PURGE',
  'NPM_CONFIG_CONFIRM_MODULES_PURGE',
  'NODE_OPTIONS',
  'COREPACK_HOME',
  'PNPM_HOME',
  'PI_ALLOW_LOCKFILE_CHANGE',
  'PI_LOCKFILE_REVIEW_EVIDENCE',
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
  'HF_HUB_OFFLINE',
  'HF_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
  'HF_HOME',
] as const;

// `var` is intentional: audit-chain constructs during the secure-io import
// cycle, before lexical module bindings are initialized.
// eslint-disable-next-line no-var
var sensitivePathMediationDepth = 0;
// eslint-disable-next-line no-var
var secureIoInitialized = false;

function isSensitivePathMediated(): boolean {
  // audit-chain seeds its index while this module is still resolving a
  // pre-existing import cycle. That bootstrap path only probes project-local
  // audit files; defer the new deny layer until secure-io is initialized.
  return sensitivePathMediationDepth > 0 || !secureIoInitialized;
}

export function withSensitivePathMediation<T>(fn: () => T): T {
  sensitivePathMediationDepth += 1;
  try {
    return fn();
  } finally {
    sensitivePathMediationDepth -= 1;
  }
}

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

/**
 * Validate a repository-relative resource path without allowing an existing
 * path component to be a symbolic link. This is intentionally separate from
 * the lexical permission checks in safeReadFile/safeWriteFile: model-facing
 * tools need to reject a path that stays lexically inside the repository but
 * resolves through a link into another scope.
 */
export function assertSafeRepositoryPath(
  filePath: string,
  options: { allowMissingLeaf?: boolean; rootDir?: string } = {}
): string {
  if (!filePath) throw new Error('Missing required resource path');

  const resolved = pathResolver.resolve(filePath);
  const root = path.resolve(options.rootDir ?? pathResolver.rootDir());
  const relative = path.relative(root, resolved).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(
      `[RESOURCE_PATH_SCOPE] resource path is outside the repository root: ${filePath}`
    );
  }

  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(
          `[RESOURCE_PATH_SYMLINK] resource path cannot traverse a symbolic link: ${filePath}`
        );
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }

  if (!options.allowMissingLeaf && !fs.existsSync(resolved)) {
    throw new Error(`Resource path does not exist: ${resolved}`);
  }
  return resolved;
}

export function buildSafeExecEnv(
  extraEnv: Record<string, string | undefined> = {}
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
  assertSensitivePathAllowed(filePath, 'read', isSensitivePathMediated());
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
  const { maxSizeMB = DEFAULT_MAX_FILE_SIZE_MB, encoding = 'utf8', label = 'input' } = options;

  if (!filePath) {
    throw new Error(`Missing required ${label} file path`);
  }

  assertSensitivePathAllowed(filePath, 'read', isSensitivePathMediated());
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

/**
 * Read and parse a JSON file safely.
 */
/**
 * Secure implementation supplied to the foundation I/O bridge.
 *
 * The public JSON reader lives in `foundation/json.ts`; keeping this
 * implementation private prevents secure-io from becoming a second reader
 * API while preserving the permission checks used by the bridge itself.
 */
function secureLoadJson<T>(filePath: string): T {
  const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  return JSON.parse(raw) as T;
}

/** Read and parse an optional JSON file, returning null for missing or invalid input. */
function secureLoadJsonIfPresent<T>(filePath: string): T | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    return secureLoadJson<T>(filePath);
  } catch {
    return null;
  }
}

// Compatibility exports remain available to callers that still import the
// secure-io module directly. Foundation JSON bootstraps this module, so the
// direction stays one-way: secure-io owns the governed implementation and
// foundation/json delegates to its registered bridge.
export const loadJson = secureLoadJson;
export const loadJsonIfPresent = secureLoadJsonIfPresent;

let _policyCheckInProgress = false;

/**
 * Write a file safely using atomic operations (write to temp -> rename).
 */
export function safeWriteFile(
  filePath: string,
  data: string | Buffer,
  options: SafeWriteOptions = {}
): void {
  const { mkdir = true } = options;
  assertSensitivePathAllowed(filePath, 'write', isSensitivePathMediated());
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
        agentId: getRegisteredEnvText('KYBERION_PERSONA') || 'unknown',
        operation: 'file_write',
        target_tier: detectTier(resolved),
        // Root operator processes are sovereign-tier by default; subagent
        // spawns can downgrade via KYBERION_AGENT_TIER so sovereign-shield
        // (personal-tier isolation) has real firing context.
        agent_tier: getRegisteredEnvText('KYBERION_AGENT_TIER') || 'sovereign',
        message: `Write to ${resolved}`,
      });
      if (!policyDecision.allowed) {
        recordGovernanceAction(
          getRegisteredEnvText('KYBERION_PERSONA') || 'unknown',
          'file_write',
          `${resolved}:denied`,
          true
        );
        auditChain.record({
          agentId: getRegisteredEnvText('KYBERION_PERSONA') || 'unknown',
          action: 'policy_violation',
          operation: 'file_write',
          result: 'failed',
          reason: policyDecision.message || 'policy violation',
          metadata: {
            target_tier: detectTier(resolved),
          },
        });
        throw new Error(
          `[POLICY_BLOCKED] Write to ${resolved} denied: ${policyDecision.message || 'policy violation'}`
        );
      }
    } catch (err: any) {
      // Only re-throw if it's an actual policy block, not a load/parse failure
      if (err?.message?.includes('[POLICY_BLOCKED]')) throw err;
      // SA-05: a broken/missing policy file must not silently disable the
      // gate — fail closed. (An earlier revision logged "allowing by
      // default" while already throwing; the message now matches reality.)
      logger.warn(
        `[secure-io] policy evaluation failed — failing closed: path=${resolved} error=${err?.message || String(err)}`
      );
      throw new Error(`Policy engine unavailable for ${resolved}: ${err?.message || err}`);
    } finally {
      _policyCheckInProgress = false;
    }
  }

  const dir = path.dirname(resolved);
  if (mkdir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`[SECURITY] Refusing to replace symbolic link: ${resolved}`);
  }

  // One retry: janitor/tmp sweeps can race the atomic write and remove the
  // temp file (or its dir) between write and rename — ENOENT here is
  // recoverable by re-materializing the temp file once.
  const writeAtomically = (): void => {
    const ns = process.hrtime.bigint().toString();
    const tempPath = `${resolved}.tmp.${ns}.${Math.random().toString(36).substring(2)}`;
    let fd: number | null = null;
    try {
      // Apply the requested mode at creation time. Applying it only through
      // writeFileSync(fd, ...) has no effect because the descriptor is already open.
      fd = fs.openSync(tempPath, 'wx', options.mode ?? 0o666);
      fs.writeFileSync(fd, data, { encoding: options.encoding });
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tempPath, resolved);
    } catch (atomicErr) {
      if (fd !== null)
        try {
          fs.closeSync(fd);
        } catch (_) {
          /* best-effort cleanup */
        }
      if (fs.existsSync(tempPath))
        try {
          fs.unlinkSync(tempPath);
        } catch (_) {
          /* best-effort cleanup */
        }
      throw atomicErr;
    }
  };

  try {
    try {
      writeAtomically();
    } catch (firstErr: any) {
      if (firstErr?.code !== 'ENOENT') throw firstErr;
      // Respect the caller's mkdir option: only re-create the directory when
      // directory creation was requested in the first place.
      if (mkdir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(dir)) throw firstErr;
      writeAtomically();
    }
    return;
  } catch (err) {
    throw err;
  }
}

/**
 * Append to a file safely.
 */
export function safeAppendFileSync(
  filePath: string,
  data: string | Buffer,
  options: any = 'utf8'
): void {
  assertSensitivePathAllowed(filePath, 'write', isSensitivePathMediated());
  const resolved = pathResolver.resolve(filePath);
  const guard = validateWritePermission(resolved);
  if (!guard.allowed) throw new Error(guard.reason);
  fs.appendFileSync(resolved, data, options);
}

/**
 * Copy a file safely with permission validation.
 */
export function safeCopyFileSync(srcPath: string, destPath: string): void {
  assertSensitivePathAllowed(srcPath, 'read', isSensitivePathMediated());
  assertSensitivePathAllowed(destPath, 'write', isSensitivePathMediated());
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
  assertSensitivePathAllowed(srcPath, 'read/write', isSensitivePathMediated());
  assertSensitivePathAllowed(destPath, 'write', isSensitivePathMediated());
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
export function safeSymlinkSync(
  targetPath: string,
  linkPath: string,
  type?: fs.symlink.Type
): void {
  assertSensitivePathAllowed(targetPath, 'read', isSensitivePathMediated());
  assertSensitivePathAllowed(linkPath, 'write', isSensitivePathMediated());
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
export function safeRmSync(
  targetPath: string,
  options: fs.RmOptions = { recursive: true, force: true }
): void {
  assertSensitivePathAllowed(targetPath, 'write', isSensitivePathMediated());
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
  assertSensitivePathAllowed(filePath, 'write', isSensitivePathMediated());
  const resolved = pathResolver.resolve(filePath);
  const guard = validateWritePermission(resolved);
  if (!guard.allowed) throw new Error(guard.reason);
  if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
}

/**
 * Create a directory safely.
 */
export function safeMkdir(
  dirPath: string,
  options: fs.MakeDirectoryOptions = { recursive: true }
): void {
  assertSensitivePathAllowed(dirPath, 'write', isSensitivePathMediated());
  const resolved = pathResolver.resolve(dirPath);
  const guard = validateWritePermission(resolved);
  if (!guard.allowed) throw new Error(guard.reason);
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, options);
  }
}

/**
 * Ensure a directory exists safely.
 */
export function ensureDir(
  dirPath: string,
  options: fs.MakeDirectoryOptions = { recursive: true }
): void {
  safeMkdir(dirPath, options);
}

/**
 * Open a file for append safely and return the file descriptor.
 */
export function safeOpenAppendFile(filePath: string): number {
  assertSensitivePathAllowed(filePath, 'write', isSensitivePathMediated());
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
export function safeCreateExclusiveFileSync(filePath: string, data: string | Buffer = ''): void {
  assertSensitivePathAllowed(filePath, 'write', isSensitivePathMediated());
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
    try {
      fs.closeSync(fd);
    } catch (_) {
      /* best-effort cleanup */
    }
    try {
      fs.unlinkSync(resolved);
    } catch (_) {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * Safely fsync an existing file for durability.
 */
export function safeFsyncFile(filePath: string): void {
  assertSensitivePathAllowed(filePath, 'write', isSensitivePathMediated());
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
 * Safely set file permissions (mode) for a given path.
 * Used primarily for secret/key files to enforce restrictive modes (e.g., 0o600).
 * Only allowed within write-permitted paths.
 */
export function safeChmodSync(filePath: string, mode: number): void {
  assertSensitivePathAllowed(filePath, 'write', isSensitivePathMediated());
  const resolved = pathResolver.resolve(filePath);
  const guard = validateWritePermission(resolved);
  if (!guard.allowed) throw new Error(guard.reason);
  fs.chmodSync(resolved, mode);
}

/**
 * Check if a file or directory exists safely.
 */
export function safeExistsSync(filePath: string): boolean {
  if (!filePath) return false;
  assertSensitivePathAllowed(filePath, 'read', isSensitivePathMediated());
  const resolved = pathResolver.resolve(filePath);
  return fs.existsSync(resolved);
}

// SA-05: gate command execution through the declarative policy engine so
// operation-type rules (ring3-read-only's execute_command, rate limits)
// actually fire. The message carries only the executable name — free-text
// command scanning is shell-command-policy's job (SA-02), and duplicating
// it here would double-regulate and false-positive on argument content.
function assertExecPolicy(command: string): void {
  const ringRaw = getRegisteredEnvText('KYBERION_AGENT_RING');
  const ring = ringRaw !== undefined && ringRaw !== '' ? Number(ringRaw) : Number.NaN;
  const decision = policyEngine.evaluate({
    agentId: getRegisteredEnvText('KYBERION_PERSONA') || 'unknown',
    operation: 'execute_command',
    message: `Execute ${command}`,
    ...(Number.isFinite(ring) ? { agent_ring: ring } : {}),
  });
  if (!decision.allowed) {
    recordGovernanceAction(
      getRegisteredEnvText('KYBERION_PERSONA') || 'unknown',
      'execute_command',
      `${command}:denied`,
      true
    );
    auditChain.record({
      agentId: getRegisteredEnvText('KYBERION_PERSONA') || 'unknown',
      action: 'policy_violation',
      operation: 'execute_command',
      result: 'failed',
      reason: decision.message || 'policy violation',
      metadata: { command },
    });
    throw new Error(
      `[POLICY_BLOCKED] execute_command denied (${command}): ${decision.message || 'policy violation'}`
    );
  }
}

/**
 * Execute a command safely and return the full result (stdout, stderr, exit code).
 * Unlike safeExec, this does NOT throw on non-zero exit codes.
 */
export function safeExecResult(
  command: string,
  args: string[] = [],
  options: any = {}
): {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
} {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cwd = process.cwd(),
    encoding = 'utf8',
    maxOutputMB = 10,
    env = {},
    input,
  } = options;

  assertSensitiveTextAllowed(`${command} ${args.join(' ')}`, 'execute');
  assertExecPolicy(command);
  try {
    const result = spawnSync(command, args, {
      encoding,
      cwd,
      env: buildSafeExecEnv(env),
      timeout: timeoutMs,
      maxBuffer: maxOutputMB * 1024 * 1024,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      stdout: (result.stdout as string) || '',
      stderr: (result.stderr as string) || '',
      status: result.status,
      error: result.error,
    };
  } catch (err: any) {
    return {
      stdout: '',
      stderr: err.message || '',
      status: err.status || 1,
      error: err,
    };
  }
}

/**
 * Execute a command asynchronously through the same governed boundary as
 * safeExecResult. This is used by independent validation gates so the runner
 * can overlap work without allowing feature code to bypass secure-io.
 */
export function safeExecResultAsync(
  command: string,
  args: string[] = [],
  options: any = {}
): Promise<{
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
}> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cwd = process.cwd(),
    env = {},
    maxOutputMB = 10,
  } = options;
  assertSensitiveTextAllowed(`${command} ${args.join(' ')}`, 'execute');
  assertExecPolicy(command);
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: buildSafeExecEnv(env),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxBytes = maxOutputMB * 1024 * 1024;
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    const finish = (result: {
      stdout: string;
      stderr: string;
      status: number | null;
      error?: Error;
    }): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    const append = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxBytes) {
        child.kill('SIGTERM');
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
    child.on('error', (error) => {
      clearTimeout(timeout);
      finish({
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        status: 1,
        error,
      });
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      const outputError = outputBytes > maxBytes;
      const error = timedOut
        ? new Error(`command timed out after ${timeoutMs}ms`)
        : outputError
          ? new Error(`command output exceeded ${maxOutputMB}MB`)
          : undefined;
      finish({
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        status: error ? 1 : status,
        ...(error ? { error } : {}),
      });
    });
  });
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

  assertSensitiveTextAllowed(`${command} ${args.join(' ')}`, 'execute');
  assertExecPolicy(command);
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
 * Start a long-lived helper through the same command and policy boundary as
 * safeExec. Callers own the returned process and must stop it explicitly.
 * This is intentionally the only async process-spawn escape hatch exposed to
 * core modules; direct node:child_process imports are not allowed at feature
 * boundaries.
 */
export function safeSpawn(
  command: string,
  args: string[] = [],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): ChildProcessWithoutNullStreams {
  assertSensitiveTextAllowed(`${command} ${args.join(' ')}`, 'execute');
  assertExecPolicy(command);
  return spawn(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: buildSafeExecEnv(options.env ?? {}),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Validate a URL against SSRF and protocol restrictions.
 */
export function validateUrl(url: string, options?: { allowLocalNetwork?: boolean }): string {
  if (!url) {
    throw new Error('Missing or invalid URL');
  }

  assertSandboxNetworkAllowed(url);

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

    const allowLocal =
      options?.allowLocalNetwork === true ||
      getRegisteredEnvBool('KYBERION_ALLOW_LOCAL_NETWORK') === true;

    if (blockedHostnames.includes(normalizedHostname)) {
      if (allowLocal) return url;
      throw new Error(`Blocked URL: ${hostname}`);
    }

    // Basic private IP range detection (IPv4)
    if (
      /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(normalizedHostname)
    ) {
      if (allowLocal) return url;
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
      if (allowLocal) return url;
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
  assertSensitivePathAllowed(dirPath, 'read', isSensitivePathMediated());
  const resolved = pathResolver.resolve(dirPath);
  const check = validateReadPermission(resolved);
  if (!check.allowed) {
    throw new Error(
      `[ROLE_VIOLATION] Role is NOT authorized to read directory '${dirPath}'. ${check.reason || ''} See knowledge/product/governance/security-policy.json for allowed paths.`
    );
  }
  return fs.readdirSync(resolved);
}

/**
 * Safely get file status with permission validation.
 */
export function safeStat(filePath: string): fs.Stats {
  assertSensitivePathAllowed(filePath, 'read', isSensitivePathMediated());
  const resolved = pathResolver.resolve(filePath);
  const check = validateReadPermission(resolved);
  if (!check.allowed) {
    throw new Error(
      `[ROLE_VIOLATION] Role is NOT authorized to stat path '${filePath}'. ${check.reason || ''} See knowledge/product/governance/security-policy.json for allowed paths.`
    );
  }
  return fs.statSync(resolved);
}

/**
 * Safely get symbolic-link-aware file status with permission validation.
 */
export function safeLstat(filePath: string): fs.Stats {
  assertSensitivePathAllowed(filePath, 'read', isSensitivePathMediated());
  const resolved = pathResolver.resolve(filePath);
  const check = validateReadPermission(resolved);
  if (!check.allowed) {
    throw new Error(
      `[ROLE_VIOLATION] Role is NOT authorized to lstat path '${filePath}'. ${check.reason || ''} See knowledge/product/governance/security-policy.json for allowed paths.`
    );
  }
  return fs.lstatSync(resolved);
}

/**
 * Safely read a symbolic link target with permission validation.
 */
export function safeReadlink(filePath: string): string {
  assertSensitivePathAllowed(filePath, 'read', isSensitivePathMediated());
  const resolved = pathResolver.resolve(filePath);
  const check = validateReadPermission(resolved);
  if (!check.allowed) {
    throw new Error(
      `[ROLE_VIOLATION] Role is NOT authorized to readlink path '${filePath}'. ${check.reason || ''} See knowledge/product/governance/security-policy.json for allowed paths.`
    );
  }
  return fs.readlinkSync(resolved);
}

registerEnvironmentRegistryReader(() =>
  secureLoadJsonIfPresent<{
    entries?: Array<{
      name: string;
      type: 'string' | 'boolean' | 'number' | 'enum' | 'path';
      enum?: string[];
    }>;
  }>(pathResolver.rootResolve('knowledge/product/governance/env-registry.json'))
);
registerFoundationIo({
  loadJson: secureLoadJson,
  loadJsonIfPresent: secureLoadJsonIfPresent,
  appendFile: (filePath, content) => safeAppendFileSync(filePath, content),
  exists: safeExistsSync,
  readFile: (filePath) => safeReadFile(filePath, { encoding: 'utf8' }) as string,
  stat: safeStat,
  writeFile: (filePath, content) => safeWriteFile(filePath, content),
});

// Test and plugin adapters may expose a deliberately reduced audit-chain
// surface. Optional chaining does not protect a Vitest namespace proxy from
// a missing named export, so resolve optional registrations behind a guarded
// lookup and keep secure-io initialization fail-closed but non-fragile.
function registerOptionalAuditIo(name: string, io: unknown): void {
  try {
    const register = (auditChainModule as unknown as Record<string, unknown>)[name];
    if (typeof register === 'function') (register as (value: unknown) => void)(io);
  } catch {
    // A reduced adapter simply has no corresponding integration seam.
  }
}

registerOptionalAuditIo('registerAuditChainIo', {
  read: (filePath) => safeReadFile(filePath, { encoding: 'utf8' }) as string,
  loadJson: secureLoadJson,
  exists: safeExistsSync,
  mkdir: (dirPath) => safeMkdir(dirPath, { recursive: true }),
  readdir: safeReaddir,
  append: (filePath, content) => safeAppendFileSync(filePath, content),
  assertSafePath: (filePath, options) => assertSafeRepositoryPath(filePath, options),
});
registerOptionalAuditIo('registerChainIntegrityIo', {
  exists: safeExistsSync,
  read: (filePath) => safeReadFile(filePath, { encoding: 'utf8' }) as string,
  mkdir: (dirPath) => safeMkdir(dirPath, { recursive: true }),
  createExclusive: (filePath, content) => safeCreateExclusiveFileSync(filePath, content),
  chmod: safeChmodSync,
});
registerOptionalAuditIo('registerLockIo', {
  exists: safeExistsSync,
  mkdir: (dirPath) => safeMkdir(dirPath, { recursive: true }),
  createExclusive: (filePath, content) => safeCreateExclusiveFileSync(filePath, content),
  unlink: safeUnlinkSync,
  loadJson: secureLoadJson,
});
secureIoInitialized = true;
