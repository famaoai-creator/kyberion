const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const crypto = require('crypto');
const v8 = require('v8');
const pathResolver = require('./path-resolver.cjs');

/**
 * Shared Utility Core for Gemini Skills.
 * Provides standardized logging, file utilities, and error handling.
 *
 * Usage:
 *   const { logger, fileUtils, errorHandler } = require('../../scripts/lib/core.cjs');
 *   logger.info('Processing started');
 *   const data = fileUtils.readJson('config.json');
 *   if (!data) errorHandler(new Error('Config missing'), 'init');
 *
 * @module core
 */

/**
 * Color-coded console logger.
 * @namespace
 */
/**
 * Internal logger with SRE traceability.
 */
const logger = {
  _log: (level, msg) => {
    if (process.env.NODE_ENV === 'test' && level !== 'error') return;
    const ts = chalk.dim(new Date().toISOString());
    const mid = process.env.MISSION_ID ? chalk.magenta(` [${process.env.MISSION_ID}]`) : '';
    const prefix =
      level === 'error'
        ? chalk.red(' [ERROR] ')
        : level === 'warn'
          ? chalk.yellow(' [WARN]  ')
          : chalk.blue(' [INFO]  ');
    console.error(`${ts}${mid}${prefix}${msg}`);
  },
  info: (msg) => logger._log('info', msg),
  warn: (msg) => logger._log('warn', msg),
  error: (msg) => logger._log('error', msg),
  success: (msg) => {
    const ts = chalk.dim(new Date().toISOString());
    const mid = process.env.MISSION_ID ? chalk.magenta(` [${process.env.MISSION_ID}]`) : '';
    console.log(`${ts}${mid}${chalk.green(' [SUCCESS] ')}${msg}`);
  },
};

/**
 * Simple Spinner for CLI feedback.
 * @namespace
 */
const ui = {
  spinner: (msg) => {
    if (process.env.NODE_ENV === 'test') return { stop: () => {} };
    const chars = ['\u25dc', '\u25dd', '\u25de', '\u25df'];
    let i = 0;
    const interval = setInterval(() => {
      process.stdout.write(`\r${chalk.cyan(chars[i++ % chars.length])} ${msg}...`);
    }, 100);
    return {
      stop: (success = true) => {
        clearInterval(interval);
        process.stdout.write(
          '\r' + (success ? chalk.green('\u2714') : chalk.red('\u2718')) + ` ${msg}\n`
        );
      },
    };
  },
  /**
   * Generates a unique mission ID for traceability.
   * @returns {string}
   */
  generateMissionId: () => {
    return (
      'MSN-' +
      Date.now().toString(36).toUpperCase() +
      '-' +
      Math.random().toString(36).substring(2, 7).toUpperCase()
    );
  },
  /**
   * Formats duration human-readably.
   */
  formatDuration: (ms) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  },
  /**
   * Simple ASCII Progress Bar.
   */
  progressBar: (current, total, width = 20) => {
    const progress = Math.min(1, current / total);
    const filled = Math.round(width * progress);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
    const percent = Math.round(progress * 100);
    return `[${chalk.cyan(bar)}] ${percent}%`;
  },
  /**
   * Simple interactive confirmation.
   * @param {string} question
   * @returns {Promise<boolean>}
   */
  confirm: (question) => {
    if (process.argv.includes('-y') || process.argv.includes('--yes')) return Promise.resolve(true);
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      readline.question(`${chalk.yellow.bold('\uff1f')} ${question} [y/N]: `, (answer) => {
        readline.close();
        resolve(answer.toLowerCase() === 'y');
      });
    });
  },
  /**
   * Generic input prompt.
   */
  ask: (question) => {
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      readline.question(`${chalk.cyan.bold('\u276f')} ${question}`, (answer) => {
        readline.close();
        resolve(answer.trim());
      });
    });
  },
  /**
   * Intelligently summarizes large data objects for CLI display.
   */
  summarize: (data, maxItems = 10) => {
    if (Array.isArray(data)) {
      if (data.length <= maxItems) return data;
      const head = data.slice(0, Math.ceil(maxItems / 2));
      const tail = data.slice(-Math.floor(maxItems / 2));
      return [...head, chalk.dim(`... (${data.length - maxItems} more items) ...`), ...tail];
    }
    if (typeof data === 'string' && data.length > 500) {
      return (
        data.substring(0, 250) + chalk.dim('\n\n... (content truncated) ...\n\n') + data.slice(-250)
      );
    }
    return data;
  },
};

/**
 * SRE Utilities for reliability and diagnostics.
 */
const sre = {
  analyzeRootCause: (errorMessage) => {
    const sigPath = path.resolve(__dirname, '../../knowledge/orchestration/error-signatures.json');
    if (!fs.existsSync(sigPath)) return null;

    try {
      const signatures = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
      for (const sig of signatures) {
        const regex = new RegExp(sig.pattern, 'i');
        if (regex.test(errorMessage)) {
          return {
            cause: sig.cause,
            impact: sig.impact,
            recommendation: sig.recommendation,
          };
        }
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  },
};

/**
 * In-memory LRU cache with TTL and optional disk persistence.
 * @class
 */
class Cache {
  /**
   * @param {number} [maxSize=100] - Maximum number of entries in memory
   * @param {number} [ttlMs=3600000] - Default time-to-live in ms
   * @param {string} [persistenceDir] - Optional disk backup directory
   */
  constructor(maxSize = 100, ttlMs = 3600000, persistenceDir) {
    this._maxSize = maxSize;
    this._ttlMs = ttlMs;
    this._persistenceDir = persistenceDir || pathResolver.shared('cache');
    /** @type {Map<string, {value: *, timestamp: number, ttl: number, persistent: boolean}>} */
    this._map = new Map();
    this._stats = { hits: 0, misses: 0, integrityFailures: 0 };
  }

  /**
   * Get current cache statistics.
   * @returns {{hits: number, misses: number, ratio: number, size: number, purges: number, integrityFailures: number}}
   */
  getStats() {
    const total = this._stats.hits + this._stats.misses;
    return {
      ...this._stats,
      size: this._map.size,
      ratio: total > 0 ? Math.round((this._stats.hits / total) * 100) : 0,
    };
  }

  /**
   * Smartly purge entries to free up memory.
   * @param {number} [fraction=0.5] - Fraction of entries to remove
   */
  purge(fraction = 0.5) {
    if (this._map.size === 0) return;

    // Sort entries by expiration time (earliest first)
    const entries = Array.from(this._map.entries())
      .map(([key, data]) => ({
        key,
        expiresAt: data.timestamp + data.ttl,
      }))
      .sort((a, b) => a.expiresAt - b.expiresAt);

    const countToRemove = Math.ceil(this._map.size * fraction);
    for (let i = 0; i < countToRemove; i++) {
      this._map.delete(entries[i].key);
    }

    if (!this._stats.purges) this._stats.purges = 0;
    this._stats.purges++;
  }

  /**
   * Reset cache statistics.
   */
  resetStats() {
    this._stats = {
      hits: 0,
      misses: 0,
      purges: this._stats.purges || 0,
      integrityFailures: this._stats.integrityFailures || 0,
    };
  }

  /**
   * Get a cached value. Returns undefined if the key is missing or expired.
   * Checks disk if not found in memory and persistence is enabled.
   * @param {string} key
   * @returns {*|undefined}
   */
  get(key) {
    const entry = this._map.get(key);

    if (!entry) {
      // Check disk if enabled
      const diskPath = this._getDiskPath(key);
      const v8Path = diskPath.replace('.json', '.v8');

      // 1. Try V8 Serialization first (Faster)
      if (fs.existsSync(v8Path)) {
        try {
          const v8Entry = v8.deserialize(fs.readFileSync(v8Path));
          if (Date.now() - v8Entry.timestamp < v8Entry.ttl) {
            // Integrity check for V8 (Full check since it's fast)
            const actualHash = this._generateHash(v8Entry.value);
            if (actualHash === v8Entry.h) {
              this._stats.hits++;
              this.set(key, v8Entry.value, v8Entry.ttl, false);
              return v8Entry.value;
            }
          }
          fs.unlinkSync(v8Path);
        } catch (_) {
          /* ignore */
        }
      }

      // 2. Fallback to JSON
      if (fs.existsSync(diskPath)) {
        try {
          const diskEntry = JSON.parse(fs.readFileSync(diskPath, 'utf8'));

          // Integrity Check: Verify hash if present
          if (diskEntry.h) {
            const actualHash = this._generateHash(diskEntry.value);
            if (actualHash !== diskEntry.h) {
              const { logger: _coreLogger } = require('./core.cjs');
              const isSampled = diskEntry.h.endsWith('S');
              _coreLogger.warn(
                `[Cache] Integrity violation for ${key}. Method: ${isSampled ? 'Sampled' : 'Full'}. Expected ${diskEntry.h}, got ${actualHash}. Purging corrupted entry.`
              );
              this._stats.integrityFailures++;
              fs.unlinkSync(diskPath);
              return undefined;
            }
          }

          if (Date.now() - diskEntry.timestamp < diskEntry.ttl) {
            this._stats.hits++;
            this.set(key, diskEntry.value, diskEntry.ttl, false); // Reload to memory
            return diskEntry.value;
          } else {
            fs.unlinkSync(diskPath); // Expired
          }
        } catch (_) {
          /* ignore corrupt disk cache */
        }
      }
      this._stats.misses++;
      return undefined;
    }

    if (Date.now() - entry.timestamp > entry.ttl) {
      this._stats.misses++;
      this._map.delete(key);
      return undefined;
    }

    this._stats.hits++;
    // Promote to most-recently-used
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  /**
   * Store a value in the cache.
   * @param {string} key
   * @param {*} value
   * @param {number} [customTtlMs] - Optional custom TTL
   * @param {boolean} [persist=false] - Whether to write to disk
   */
  set(key, value, customTtlMs, persist = false) {
    const ttl = customTtlMs || this._ttlMs;
    const timestamp = Date.now();

    // 1. Memory Check: If heap is over 80% used, clear some entries
    if (process.env.NODE_ENV !== 'test') {
      const mem = process.memoryUsage();
      if (mem.heapUsed / mem.heapTotal > 0.8) {
        this.purge(0.3); // Gradually remove 30% instead of total clear
      }
    }

    // 2. Memory Storage
    if (this._map.has(key)) this._map.delete(key);
    if (this._map.size >= this._maxSize) {
      const lruKey = this._map.keys().next().value;
      this._map.delete(lruKey);
    }
    this._map.set(key, { value, timestamp, ttl, persistent: persist });

    // 3. Disk Storage
    if (persist) {
      const diskPath = this._getDiskPath(key);
      const v8Path = diskPath.replace('.json', '.v8');
      try {
        if (!fs.existsSync(this._persistenceDir))
          fs.mkdirSync(this._persistenceDir, { recursive: true });
        const hash = this._generateHash(value);
        const entry = { value, timestamp, ttl, h: hash };

        // Save both for migration/transparency, but V8 is preferred on load
        fs.writeFileSync(v8Path, v8.serialize(entry));
        fs.writeFileSync(diskPath, JSON.stringify(entry), 'utf8');
      } catch (_) {
        /* ignore write errors */
      }
    }
  }

  /** @private */
  _generateHash(data) {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    const buf = Buffer.from(str);
    const len = buf.length;

    // Sampling Strategy for large data (> 64KB)
    if (len > 64 * 1024) {
      const sampleSize = 16 * 1024;
      const mid = Math.floor(len / 2);

      const combined = Buffer.concat([
        buf.subarray(0, sampleSize),
        buf.subarray(mid - sampleSize / 2, mid + sampleSize / 2),
        buf.subarray(len - sampleSize, len),
        Buffer.from(len.toString()), // Include length to detect truncation
      ]);
      return crypto.createHash('md5').update(combined).digest('hex').substring(0, 8) + 'S'; // 'S' indicates sampled
    }

    return crypto.createHash('md5').update(buf).digest('hex').substring(0, 8);
  }

  /** @private */
  _getDiskPath(key) {
    const safeKey = key.replace(/[^a-z0-9]/gi, '_').substring(0, 100);
    return path.join(this._persistenceDir, `${safeKey}.cache.json`);
  }

  /**
   * Check if a key exists and has not expired.
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    const entry = this._map.get(key);
    if (!entry) return false;
    if (Date.now() - entry.timestamp > entry.ttl) {
      this._map.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Remove all entries from the cache.
   */
  clear() {
    this._map.clear();
  }

  /**
   * Current number of entries (including potentially expired ones).
   * @type {number}
   */
  get size() {
    return this._map.size;
  }
}

// Internal file-read cache: keyed by resolved path, stores {mtimeMs, data}
const _fileCache = new Cache(200, 3600000);

/**
 * Global error handler. Logs error and exits with code 1.
 * Set DEBUG=1 env var to see full stack traces.
 * @param {Error} err - The error object
 * @param {string} [context=''] - Description of where the error occurred
 */
const errorHandler = (err, context = '') => {
  logger.error(`${context}: ${err.message || err}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
};

/**
 * File system utilities with safe defaults.
 * @namespace
 */
const fileUtils = {
  /**
   * Gets the current role from role-config.json.
   * @returns {string} The role name (e.g., 'Ecosystem Architect') or 'Unknown'
   */
  getCurrentRole: () => {
    const config = fileUtils.getFullRoleConfig();
    return config ? config.active_role || config.role : 'Unknown';
  },
  /**
   * Gets the full role configuration.
   * @returns {Object|null}
   */
  getFullRoleConfig: () => {
    const configPath = path.resolve(__dirname, '../../knowledge/personal/role-config.json');
    return fileUtils.readJson(configPath);
  },
  /**
   * Ensure a directory exists, creating it recursively if needed.
   * @param {string} dirPath - Directory path to create
   */
  ensureDir: (dirPath) => {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  },
  /**
   * Read and parse a JSON file with mtime-based caching.
   * Cached results are returned when the file has not been modified.
   * Returns null on any error.
   * @param {string} filePath - Path to JSON file
   * @returns {Object|null} Parsed JSON or null
   */
  readJson: (filePath) => {
    try {
      const resolved = path.resolve(filePath);
      const stat = fs.statSync(resolved);
      const mtimeMs = stat.mtimeMs;

      // Check cache: return cached data if mtime matches
      const cached = _fileCache.get(resolved);
      if (cached && cached.mtimeMs === mtimeMs) {
        return cached.data;
      }

      // Read fresh
      const content = fs.readFileSync(resolved, 'utf8');
      const data = JSON.parse(content);

      // Cache optimization: Only cache files smaller than 5MB
      if (stat.size < 5 * 1024 * 1024) {
        // Persist critical index files to disk for cold-start performance
        const isIndex = resolved.includes('global_skill_index.json');
        _fileCache.set(resolved, { mtimeMs, data }, null, isIndex);
      }

      return data;
    } catch (_e) {
      return null;
    }
  },
  /**
   * Write data as formatted JSON to a file.
   * @param {string} filePath - Output file path
   * @param {*} data - Data to serialize
   */
  writeJson: (filePath, data) => {
    try {
      const { safeWriteFile } = require('./secure-io.cjs');
      safeWriteFile(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      errorHandler(err, 'fileUtils.writeJson');
    }
  },
};

module.exports = {
  logger,
  ui,
  sre,
  fileUtils,
  errorHandler,
  Cache,
  _fileCache, // Export for secure-io integration
};
