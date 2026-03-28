import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as v8 from 'node:v8';
import * as readline from 'node:readline';
import chalk from 'chalk';
import { pathResolver } from './path-resolver.js';
import {
  rawExistsSync,
  rawMkdirp,
  rawReadBuffer,
  rawReadTextFile,
  rawStatSync,
  rawUnlinkSync,
  rawWriteFile,
} from './fs-primitives.js';

/**
 * Shared Utility Core for Kyberion (TypeScript Edition)
 */

export const logger = {
  _log: (level: string, msg: string) => {
    if (process.env.NODE_ENV === 'test' && level !== 'error') return;
    const ts = chalk.dim(new Date().toISOString());
    const mid = process.env.MISSION_ID ? chalk.magenta(' [' + process.env.MISSION_ID + ']') : '';
    const prefix =
      level === 'error'
        ? chalk.red(' [ERROR] ')
        : level === 'warn'
          ? chalk.yellow(' [WARN]  ')
          : chalk.blue(' [INFO]  ');
    console.error(ts + mid + prefix + msg);
  },
  info: (msg: string) => logger._log('info', msg),
  warn: (msg: string) => logger._log('warn', msg),
  error: (msg: string) => logger._log('error', msg),
  success: (msg: string) => {
    const ts = chalk.dim(new Date().toISOString());
    const mid = process.env.MISSION_ID ? chalk.magenta(' [' + process.env.MISSION_ID + ']') : '';
    console.log(ts + mid + chalk.green(' [SUCCESS] ') + msg);
  },
};

export const ui = {
  spinner: (msg: string) => {
    if (process.env.NODE_ENV === 'test') return { stop: () => {} };
    const chars = ['\u25dc', '\u25dd', '\u25de', '\u25df'];
    let i = 0;
    const interval = setInterval(() => {
      process.stdout.write('\r' + chalk.cyan(chars[i++ % chars.length]) + ' ' + msg + '...');
    }, 100);
    interval.unref?.();
    return {
      stop: (success = true) => {
        clearInterval(interval);
        process.stdout.write(
          '\r' + (success ? chalk.green('\u2714') : chalk.red('\u2718')) + ' ' + msg + '\n'
        );
      },
    };
  },
  generateMissionId: () => {
    return (
      'MSN-' +
      Date.now().toString(36).toUpperCase() +
      '-' +
      Math.random().toString(36).substring(2, 7).toUpperCase()
    );
  },
  formatDuration: (ms: number) => {
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  },
  progressBar: (current: number, total: number, width = 20) => {
    const progress = Math.min(1, current / total);
    const filled = Math.round(width * progress);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
    const percent = Math.round(progress * 100);
    return '[' + chalk.cyan(bar) + '] ' + percent + '%';
  },
  confirm: (question: string): Promise<boolean> => {
    if (process.argv.includes('-y') || process.argv.includes('--yes')) return Promise.resolve(true);
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      rl.question(chalk.yellow.bold('\uff1f') + ' ' + question + ' [y/N]: ', (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === 'y');
      });
    });
  },
  ask: (question: string): Promise<string> => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      rl.question(chalk.cyan.bold('\u276f') + ' ' + question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  },
  summarize: (data: any, maxItems = 10): any => {
    if (Array.isArray(data)) {
      if (data.length <= maxItems) return data;
      const head = data.slice(0, Math.ceil(maxItems / 2));
      const tail = data.slice(-Math.floor(maxItems / 2));
      return [...head, chalk.dim('... (' + (data.length - maxItems) + ' more items) ...'), ...tail];
    }
    if (typeof data === 'string' && data.length > 500) {
      return (
        data.substring(0, 250) + chalk.dim('\n\n... (content truncated) ...\n\n') + data.slice(-250)
      );
    }
    return data;
  },
  stripAnsi: (input: string): string => {
    return input
      .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '') // CSI
      .replace(/\x1B\].*?(\x07|\x1B\\)/g, '') // OSC
      .replace(/\x1B[()#;?]./g, '') // ESC + single char
      .replace(/\x1B[PX^_].*?\x1B\\/g, '') // DCS, SOS, PM, APC
      .replace(/\r/g, ''); // Carriage returns
  },
};

export const sre = {
  analyzeRootCause: (errorMessage: string) => {
    const sigPath = pathResolver.knowledge('orchestration/error-signatures.json');
    const results = [];
    
    if (rawExistsSync(sigPath)) {
      try {
        const signatures = JSON.parse(rawReadTextFile(sigPath));
        for (const sig of signatures) {
          const regex = new RegExp(sig.pattern, 'i');
          if (regex.test(errorMessage)) {
            results.push({
              cause: sig.cause,
              impact: sig.impact,
              recommendation: sig.recommendation,
              action: sig.action // New field for machine-executable command hint
            });
          }
        }
      } catch (_) {}
    }
    
    // Fallback heuristic for TS/JS errors
    if (results.length === 0) {
      if (errorMessage.includes('Property') && errorMessage.includes('does not exist')) {
        results.push({
          cause: 'TypeScript Type Mismatch',
          impact: 'Compilation failure',
          recommendation: 'Check the object interface and property name.',
          action: 'inspect_interface'
        });
      }
    }

    return results[0] || null;
  },
};

export class Cache {
  private _maxSize: number;
  private _ttlMs: number;
  private _persistenceDir: string;
  private _map: Map<string, any>;
  private _stats: any;

  constructor(maxSize = 100, ttlMs = 3600000, persistenceDir?: string) {
    this._maxSize = maxSize;
    this._ttlMs = ttlMs;
    this._persistenceDir = persistenceDir || pathResolver.shared('cache');
    this._map = new Map();
    this._stats = { hits: 0, misses: 0, integrityFailures: 0 };
  }

  getStats() {
    const total = this._stats.hits + this._stats.misses;
    return {
      ...this._stats,
      size: this._map.size,
      ratio: total > 0 ? Math.round((this._stats.hits / total) * 100) : 0,
    };
  }

  purge(fraction = 0.5) {
    if (this._map.size === 0) return;
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

  get(key: string) {
    const entry = this._map.get(key);
    if (!entry) {
      const diskPath = this._getDiskPath(key);
      const v8Path = diskPath.replace('.json', '.v8');

      if (rawExistsSync(v8Path)) {
        try {
          const v8Entry = v8.deserialize(rawReadBuffer(v8Path));
          if (Date.now() - v8Entry.timestamp < v8Entry.ttl) {
            const actualHash = this._generateHash(v8Entry.value);
            if (actualHash === v8Entry.h) {
              this._stats.hits++;
              this.set(key, v8Entry.value, v8Entry.ttl, false);
              return v8Entry.value;
            }
          }
          rawUnlinkSync(v8Path);
        } catch (_) {}
      }

      if (rawExistsSync(diskPath)) {
        try {
          const diskEntry = JSON.parse(rawReadTextFile(diskPath));
          if (diskEntry.h) {
            const actualHash = this._generateHash(diskEntry.value);
            if (actualHash !== diskEntry.h) {
              this._stats.integrityFailures++;
              rawUnlinkSync(diskPath);
              return undefined;
            }
          }
          if (Date.now() - diskEntry.timestamp < diskEntry.ttl) {
            this._stats.hits++;
            this.set(key, diskEntry.value, diskEntry.ttl, false);
            return diskEntry.value;
          } else {
            rawUnlinkSync(diskPath);
          }
        } catch (_) {}
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
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: any, customTtlMs?: number, persist = false) {
    const ttl = customTtlMs || this._ttlMs;
    const timestamp = Date.now();

    if (process.env.NODE_ENV !== 'test') {
      const mem = process.memoryUsage();
      const usageRatio = mem.heapUsed / mem.heapTotal;
      if (usageRatio > 0.8) {
        const purgeRatio = usageRatio > 0.9 ? 0.8 : 0.4;
        this.purge(purgeRatio);
      }
    }

    if (this._map.has(key)) this._map.delete(key);
    if (this._map.size >= this._maxSize) {
      const lruKey = this._map.keys().next().value;
      if (lruKey !== undefined) this._map.delete(lruKey);
    }
    this._map.set(key, { value, timestamp, ttl, persistent: persist });

    if (persist) {
      const diskPath = this._getDiskPath(key);
      const v8Path = diskPath.replace('.json', '.v8');
      try {
        if (!rawExistsSync(this._persistenceDir))
          rawMkdirp(this._persistenceDir);
        const hash = this._generateHash(value);
        const entry = { value, timestamp, ttl, h: hash };
        rawWriteFile(v8Path, v8.serialize(entry));
        rawWriteFile(diskPath, JSON.stringify(entry));
      } catch (_) {}
    }
  }

  private _generateHash(data: any) {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    const buf = Buffer.from(str);
    const len = buf.length;
    if (len > 64 * 1024) {
      const sampleSize = 16 * 1024;
      const mid = Math.floor(len / 2);
      const combined = Buffer.concat([
        buf.subarray(0, sampleSize),
        buf.subarray(mid - sampleSize / 2, mid + sampleSize / 2),
        buf.subarray(len - sampleSize, len),
        Buffer.from(len.toString()),
      ]);
      return createHash('md5').update(combined).digest('hex').substring(0, 8) + 'S';
    }
    return createHash('md5').update(buf).digest('hex').substring(0, 8);
  }

  private _getDiskPath(key: string) {
    const safeKey = key.replace(/[^a-z0-9]/gi, '_').substring(0, 100);
    return path.join(this._persistenceDir, safeKey + '.cache.json');
  }

  has(key: string) {
    const entry = this._map.get(key);
    if (!entry) return false;
    if (Date.now() - entry.timestamp > entry.ttl) {
      this._map.delete(key);
      return false;
    }
    return true;
  }

  clear() { this._map.clear(); }
  get size() { return this._map.size; }
}

export const _fileCache = new Cache(200, 3600000);

export const errorHandler = (err: any, context = '') => {
  logger.error(context + ': ' + (err.message || err));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
};

export const fileUtils = {
  getCurrentRole: () => {
    const config = fileUtils.getFullRoleConfig();
    return config ? config.active_role || config.role : 'Unknown';
  },
  getFullRoleConfig: () => {
    const mid = process.env.MISSION_ID;
    const priorityPaths: string[] = [];
    if (mid) priorityPaths.push(pathResolver.active(`missions/${mid}/role-state.json`));
    priorityPaths.push(pathResolver.shared('governance/session.json'));
    priorityPaths.push(pathResolver.knowledge('personal/role-config.json'));

    for (const p of priorityPaths) {
      if (rawExistsSync(p)) {
        const config = fileUtils.readJson(p);
        if (config && (config.active_role || config.role)) return config;
      }
    }
    return null;
  },
  ensureDir: (dirPath: string) => {
    if (!rawExistsSync(dirPath)) rawMkdirp(dirPath);
  },
  readJson: (filePath: string) => {
    try {
      const resolved = path.resolve(filePath);
      const stat = rawStatSync(resolved);
      const mtimeMs = stat.mtimeMs;
      const cached = _fileCache.get(resolved);
      if (cached && cached.mtimeMs === mtimeMs) return cached.data;

      const content = rawReadTextFile(resolved);
      const data = JSON.parse(content);
      if (stat.size < 5 * 1024 * 1024) {
        const isIndex = resolved.includes('global_actuator_index.json');
        _fileCache.set(resolved, { mtimeMs, data }, undefined, isIndex);
      }
      return data;
    } catch (_) { return null; }
  },
  writeJson: (filePath: string, data: any) => {
    try {
      rawWriteFile(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      errorHandler(err, 'fileUtils.writeJson');
    }
  },
  getGoldenRule: () => {
    const rulePath = pathResolver.vision('_default.md');
    if (rawExistsSync(rulePath)) {
      return rawReadTextFile(rulePath);
    }
    return 'Logic is a Hygiene Factor. Vision is the Compass.';
  },
};
