const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

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
 * Read a file with size validation.
 * Combines file existence check, size validation, and reading.
 * @param {string} filePath - Path to read
 * @param {Object} [options] - Options
 * @param {number} [options.maxSizeMB=100] - Maximum file size in MB
 * @param {string} [options.encoding='utf8'] - File encoding
 * @param {string} [options.label='input'] - Label for error messages
 * @returns {string|Buffer} File contents
 * @throws {Error} If file not found, not a file, or exceeds size limit
 */
function safeReadFile(filePath, options = {}) {
  const { maxSizeMB = DEFAULT_MAX_FILE_SIZE_MB, encoding = 'utf8', label = 'input' } = options;

  if (!filePath) {
    throw new Error(`Missing required ${label} file path`);
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`Not a file: ${resolved}`);
  }
  validateFileSize(resolved, maxSizeMB);
  return fs.readFileSync(resolved, encoding);
}

/**
 * Write a file safely with size validation and role-based write control.
 * @param {string} filePath - Path to write
 * @param {string|Buffer} data - Content to write
 * @param {Object} [options] - Options
 * @param {boolean} [options.mkdir=true] - Create parent directory if missing
 * @param {string} [options.encoding='utf8'] - File encoding
 * @throws {Error} If write is denied by role-based control or FS error
 */
function safeWriteFile(filePath, data, options = {}) {
  const { mkdir = true, encoding = 'utf8' } = options;
  const resolved = path.resolve(filePath);

  // Integrate role-based write control (Lazy-load to avoid circular deps)
  const { validateWritePermission } = require('./tier-guard.cjs');
  const guard = validateWritePermission(resolved);
  if (!guard.allowed) {
    throw new Error(guard.reason);
  }

  if (mkdir) {
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  fs.writeFileSync(resolved, data, encoding);
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
    .replace(/\0/g, '')          // Remove null bytes
    .replace(/\.\.\//g, '')      // Remove path traversal
    .replace(/\.\.\\/g, '')      // Remove Windows path traversal
    .replace(/^[/\\]+/, '');     // Remove leading slashes
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
  safeExec,
  safeSpawn,
  sanitizePath,
  validateUrl,
  DEFAULT_MAX_FILE_SIZE_MB,
  DEFAULT_TIMEOUT_MS,
};
