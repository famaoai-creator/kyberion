const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

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
const logger = {
  /** @param {string} msg - Info message (blue) */
  info: (msg) => console.log(chalk.blue(' [INFO] ') + msg),
  /** @param {string} msg - Success message (green) */
  success: (msg) => console.log(chalk.green(' [SUCCESS] ') + msg),
  /** @param {string} msg - Warning message (yellow) */
  warn: (msg) => console.log(chalk.yellow(' [WARN] ') + msg),
  /** @param {string} msg - Error message (red, to stderr) */
  error: (msg) => console.error(chalk.red(' [ERROR] ') + msg),
};

/**
 * In-memory LRU cache with TTL support.
 * No external dependencies required.
 *
 * Usage:
 *   const { Cache } = require('../../scripts/lib/core.cjs');
 *   const cache = new Cache(50, 60000); // 50 entries, 1 min TTL
 *   cache.set('key', value);
 *   const val = cache.get('key'); // undefined if expired or missing
 *
 * @class
 */
class Cache {
  /**
   * @param {number} [maxSize=100] - Maximum number of entries in the cache
   * @param {number} [ttlMs=3600000] - Time-to-live in milliseconds (default 1 hour)
   */
  constructor(maxSize = 100, ttlMs = 3600000) {
    this._maxSize = maxSize;
    this._ttlMs = ttlMs;
    /** @type {Map<string, {value: *, timestamp: number}>} */
    this._map = new Map();
  }

  /**
   * Get a cached value. Returns undefined if the key is missing or expired.
   * Promotes the key to most-recently-used on access.
   * @param {string} key
   * @returns {*|undefined}
   */
  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > entry.ttl) {
      this._map.delete(key);
      return undefined;
    }
    // Promote to most-recently-used by re-inserting
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  /**
   * Store a value in the cache. Evicts the least-recently-used entry if full or memory is low.
   * @param {string} key
   * @param {*} value
   * @param {number} [customTtlMs] - Optional custom TTL for this entry
   */
  set(key, value, customTtlMs) {
    // 1. Memory Check: If heap is over 80% used, clear some entries
    const mem = process.memoryUsage();
    if (mem.heapUsed / mem.heapTotal > 0.8) {
      const { logger } = require('./core.cjs');
      logger.warn('[Cache] High memory usage detected, purging half of the cache entries.');
      const keysToKeep = Array.from(this._map.keys()).slice(Math.floor(this._map.size / 2));
      const newMap = new Map();
      keysToKeep.forEach(k => newMap.set(k, this._map.get(k)));
      this._map = newMap;
    }

    // 2. Standard LRU Logic
    if (this._map.has(key)) {
      this._map.delete(key);
    }
    // Evict LRU (first entry in Map iteration order) if at capacity
    if (this._map.size >= this._maxSize) {
      const lruKey = this._map.keys().next().value;
      this._map.delete(lruKey);
    }
    this._map.set(key, { value, timestamp: Date.now(), ttl: customTtlMs || this._ttlMs });
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
    const configPath = path.resolve(__dirname, '../../knowledge/personal/role-config.json');
    const config = fileUtils.readJson(configPath);
    return config ? config.role : 'Unknown';
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
        _fileCache.set(resolved, { mtimeMs, data });
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
  fileUtils,
  errorHandler,
  Cache,
};
