const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

/**
 * Secure I/O utilities for Gemini Skills.
 * Provides file size validation, safe command execution, and resource guards.
 *
 * Usage:
 *   const { safeReadFile, safeExec, validateFileSize } = require('../../scripts/lib/secure-io.cjs');
 *   const content = safeReadFile('/path/to/file', { maxSizeMB: 50 });
 *   const result = safeExec('git', ['log', '--oneline'], { timeoutMs: 10000 });
 *
 * @module secure-io
 */

const DEFAULT_MAX_FILE_SIZE_MB = 100;
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Validate that a file does not exceed a size limit.
 * @param {string} filePath - Path to validate
 * @param {number} [maxSizeMB=100] - Maximum file size in megabytes
 * @returns {number} File size in bytes
 * @throws {Error} If file exceeds size limit
 */
function validateFileSize(filePath, maxSizeMB = DEFAULT_MAX_FILE_SIZE_MB) {
  const resolved = path.resolve(filePath);
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
 * @param {string} filePath - Path to read
 * @param {import('./types').SafeReadOptions} [options] - Options
 * @returns {string|Buffer} File contents
 */
function safeReadFile(filePath, options = {}) {
  const {
    maxSizeMB = DEFAULT_MAX_FILE_SIZE_MB,
    encoding = 'utf8',
    label = 'input',
    cache = true,
  } = options;

  if (!filePath) {
    throw new Error(`Missing required ${label} file path`);
  }
  const resolved = path.resolve(filePath);

  // 1. Cache Check
  if (cache) {
    const { fileUtils: _fileUtils } = require('./core.cjs');
    // Note: readJson already uses caching, but raw file reads don't.
    // For raw files, we use a dedicated cache key.
    const cacheKey = `raw:${resolved}`;
    const { _fileCache } = require('./core.cjs'); // Internal cache access

    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      const cached = _fileCache.get(cacheKey);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.data;
      }

      // 2. Fresh Read
      if (stat.size > maxSizeMB * 1024 * 1024) {
        throw new Error(`File too large: ${resolved}`);
      }
      const data = fs.readFileSync(resolved, encoding);

      // Store in cache if small enough
      if (stat.size < 1 * 1024 * 1024) {
        _fileCache.set(cacheKey, { mtimeMs: stat.mtimeMs, data });
      }
      return data;
    }
  }

  // Fallback for non-cached or missing (existence check will throw)
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  validateFileSize(resolved, maxSizeMB);
  return fs.readFileSync(resolved, encoding);
}

/**
 * Read a file asynchronously with size validation and caching.
 * @param {string} filePath - Path to read
 * @param {import('./types').SafeReadOptions} [options] - Options
 * @returns {Promise<string|Buffer>} File contents
 */
async function safeReadFileAsync(filePath, options = {}) {
  const {
    maxSizeMB = DEFAULT_MAX_FILE_SIZE_MB,
    encoding = 'utf8',
    label = 'input',
    cache = true,
  } = options;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!filePath) {
    throw new Error(`Missing required ${label} file path`);
  }
  const resolved = path.resolve(filePath);

  // 1. Cache Check
  if (cache) {
    const { _fileCache } = require('./core.cjs');
    const cacheKey = `raw:${resolved}`;

    // Check memory cache first (synchronous check is fine)
    if (fs.existsSync(resolved)) {
      const stat = await fs.promises.stat(resolved);
      const cached = _fileCache.get(cacheKey);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.data;
      }

      // 2. Fresh Async Read with Timeout
      if (stat.size > maxSizeMB * 1024 * 1024) {
        throw new Error(`File too large: ${resolved}`);
      }

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);

      try {
        const data = await fs.promises.readFile(resolved, { encoding, signal: ac.signal });
        // Store in cache if small enough
        if (stat.size < 1 * 1024 * 1024) {
          _fileCache.set(cacheKey, { mtimeMs: stat.mtimeMs, data });
        }
        return data;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  // Fallback
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const stat = await fs.promises.stat(resolved);
    if (stat.size > maxSizeMB * 1024 * 1024) throw new Error(`File too large: ${resolved}`);
    return await fs.promises.readFile(resolved, { encoding, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Write a file safely using atomic operations (write to temp -> rename).
 * Prevents partial writes or corruption on crash.
 * @param {string} filePath - Path to write
 * @param {string|Buffer} data - Content to write
 * @param {import('./types').SafeWriteOptions} [options] - Options
 */
function safeWriteFile(filePath, data, options = {}) {
  const { mkdir = true, encoding = 'utf8' } = options;
  const resolved = path.resolve(filePath);

  // Integrate role-based write control
  const { validateWritePermission } = require('./tier-guard.cjs');
  const guard = validateWritePermission(resolved);
  if (!guard.allowed) {
    throw new Error(guard.reason);
  }

  const dir = path.dirname(resolved);
  if (mkdir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Atomic Write Strategy with Durability (fsync) and Nanosecond Precision
  const ns = process.hrtime.bigint().toString();
  const tempPath = `${resolved}.tmp.${ns}.${Math.random().toString(36).substring(2)}`;

  let fd;
  try {
    fd = fs.openSync(tempPath, 'w');
    fs.writeFileSync(fd, data, encoding);
    fs.fsyncSync(fd); // Force OS to sync to disk
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, resolved);
  } catch (err) {
    // Cleanup
    if (fd)
      try {
        fs.closeSync(fd);
      } catch (_) {}
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (_) {}
    }
    throw err;
  }
}

/**
 * Append to a file safely with role-based write control.
 */
function safeAppendFileSync(filePath, data, encoding = 'utf8') {
  const resolved = path.resolve(filePath);
  const { validateWritePermission } = require('./tier-guard.cjs');
  const guard = validateWritePermission(resolved);
  if (!guard.allowed) throw new Error(guard.reason);
  fs.appendFileSync(resolved, data, encoding);
}

/**
 * Unlink a file safely with role-based write control.
 */
function safeUnlinkSync(filePath) {
  const resolved = path.resolve(filePath);
  const { validateWritePermission } = require('./tier-guard.cjs');
  const guard = validateWritePermission(resolved);
  if (!guard.allowed) throw new Error(guard.reason);
  if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
}

/**
 * Safely pipe streams with error handling and cleanup.
 * @param {import('stream').Readable} source
 * @param {import('stream').Writable} destination
 * @returns {Promise<void>}
 */
async function safeStreamPipeline(source, destination) {
  try {
    await pipeline(source, destination);
  } catch (err) {
    // Ensure streams are destroyed on error
    if (!source.destroyed) source.destroy();
    if (!destination.destroyed) destination.destroy();
    throw err;
  }
}

/**
 * Execute a command safely using execFileSync (no shell interpolation).
 * Uses execFileSync instead of execSync to prevent shell injection.
 * @param {string} command - The command to run (no shell expansion)
 * @param {string[]} args - Array of arguments (properly escaped by Node)
 * @param {Object} [options] - Execution options
 * @param {number} [options.timeoutMs=30000] - Timeout in milliseconds
 * @param {string} [options.cwd] - Working directory
 * @param {string} [options.encoding='utf8'] - Output encoding
 * @param {number} [options.maxOutputMB=10] - Maximum output size in MB
 * @returns {string} Command stdout
 * @throws {Error} If command fails, times out, or output too large
 */
function safeExec(command, args = [], options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cwd = process.cwd(),
    encoding = 'utf8',
    maxOutputMB = 10,
  } = options;

  const result = execFileSync(command, args, {
    encoding,
    cwd,
    timeout: timeoutMs,
    maxBuffer: maxOutputMB * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return result;
}

/**
 * Execute a command safely using spawnSync with output streaming.
 * Returns both stdout and stderr with exit code.
 * @param {string} command - The command to run
 * @param {string[]} args - Array of arguments
 * @param {Object} [options] - Execution options
 * @param {number} [options.timeoutMs=30000] - Timeout in milliseconds
 * @param {string} [options.cwd] - Working directory
 * @returns {{stdout: string, stderr: string, exitCode: number, signal: string|null}}
 */
function safeSpawn(command, args = [], options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, cwd = process.cwd() } = options;

  const result = spawnSync(command, args, {
    encoding: 'utf8',
    cwd,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status !== null ? result.status : 1,
    signal: result.signal || null,
  };
}

/**
 * Sanitize a string for safe use in file paths.
 * Removes path traversal attempts and null bytes.
 * @param {string} input - Raw string
 * @returns {string} Sanitized string
 */
function sanitizePath(input) {
  if (!input || typeof input !== 'string') return '';
  return input
    .replace(/\0/g, '') // Remove null bytes
    .replace(/\.\.\//g, '') // Remove path traversal
    .replace(/\.\.\\/g, '') // Remove Windows path traversal
    .replace(/^[/\\]+/, ''); // Remove leading slashes
}

/**
 * Validate a URL for safe fetching.
 * Blocks private/internal network addresses.
 * @param {string} url - URL to validate
 * @returns {string} Validated URL
 * @throws {Error} If URL is invalid or points to private network
 */
function validateUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('Missing or invalid URL');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new Error(`Invalid URL: ${url}`);
  }

  // Block non-HTTP(S) protocols
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }

  // Block private/internal addresses
  const hostname = parsed.hostname.toLowerCase();
  const blockedPatterns = [
    /^localhost$/,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^0\.0\.0\.0$/,
    /^::1$/,
    /^fc00:/,
    /^fe80:/,
    /\.local$/,
  ];

  for (const pattern of blockedPatterns) {
    if (pattern.test(hostname)) {
      throw new Error(`Blocked URL: private/internal address not allowed (${hostname})`);
    }
  }

  return url;
}

module.exports = {
  validateFileSize,
  safeReadFile,
  safeReadFileAsync,
  safeWriteFile,
  safeAppendFileSync,
  safeUnlinkSync,
  safeStreamPipeline,
  safeExec,
  safeSpawn,
  sanitizePath,
  validateUrl,
  DEFAULT_MAX_FILE_SIZE_MB,
  DEFAULT_TIMEOUT_MS,
};
