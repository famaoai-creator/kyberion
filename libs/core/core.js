"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fileUtils = exports.errorHandler = exports._fileCache = exports.Cache = exports.sre = exports.ui = exports.logger = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const v8 = __importStar(require("node:v8"));
const readline = __importStar(require("node:readline"));
const chalk_1 = __importDefault(require("chalk"));
/**
 * Shared Utility Core for Kyberion (TypeScript Edition)
 */
exports.logger = {
    _log: (level, msg) => {
        if (process.env.NODE_ENV === 'test' && level !== 'error')
            return;
        const ts = chalk_1.default.dim(new Date().toISOString());
        const mid = process.env.MISSION_ID ? chalk_1.default.magenta(' [' + process.env.MISSION_ID + ']') : '';
        const prefix = level === 'error'
            ? chalk_1.default.red(' [ERROR] ')
            : level === 'warn'
                ? chalk_1.default.yellow(' [WARN]  ')
                : chalk_1.default.blue(' [INFO]  ');
        console.error(ts + mid + prefix + msg);
    },
    info: (msg) => exports.logger._log('info', msg),
    warn: (msg) => exports.logger._log('warn', msg),
    error: (msg) => exports.logger._log('error', msg),
    success: (msg) => {
        const ts = chalk_1.default.dim(new Date().toISOString());
        const mid = process.env.MISSION_ID ? chalk_1.default.magenta(' [' + process.env.MISSION_ID + ']') : '';
        console.log(ts + mid + chalk_1.default.green(' [SUCCESS] ') + msg);
    },
};
exports.ui = {
    spinner: (msg) => {
        if (process.env.NODE_ENV === 'test')
            return { stop: () => { } };
        const chars = ['\u25dc', '\u25dd', '\u25de', '\u25df'];
        let i = 0;
        const interval = setInterval(() => {
            process.stdout.write('\r' + chalk_1.default.cyan(chars[i++ % chars.length]) + ' ' + msg + '...');
        }, 100);
        return {
            stop: (success = true) => {
                clearInterval(interval);
                process.stdout.write('\r' + (success ? chalk_1.default.green('\u2714') : chalk_1.default.red('\u2718')) + ' ' + msg + '\n');
            },
        };
    },
    generateMissionId: () => {
        return ('MSN-' +
            Date.now().toString(36).toUpperCase() +
            '-' +
            Math.random().toString(36).substring(2, 7).toUpperCase());
    },
    formatDuration: (ms) => {
        if (ms < 1000)
            return ms + 'ms';
        return (ms / 1000).toFixed(1) + 's';
    },
    progressBar: (current, total, width = 20) => {
        const progress = Math.min(1, current / total);
        const filled = Math.round(width * progress);
        const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
        const percent = Math.round(progress * 100);
        return '[' + chalk_1.default.cyan(bar) + '] ' + percent + '%';
    },
    confirm: (question) => {
        if (process.argv.includes('-y') || process.argv.includes('--yes'))
            return Promise.resolve(true);
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        return new Promise((resolve) => {
            rl.question(chalk_1.default.yellow.bold('\uff1f') + ' ' + question + ' [y/N]: ', (answer) => {
                rl.close();
                resolve(answer.toLowerCase() === 'y');
            });
        });
    },
    ask: (question) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        return new Promise((resolve) => {
            rl.question(chalk_1.default.cyan.bold('\u276f') + ' ' + question, (answer) => {
                rl.close();
                resolve(answer.trim());
            });
        });
    },
    summarize: (data, maxItems = 10) => {
        if (Array.isArray(data)) {
            if (data.length <= maxItems)
                return data;
            const head = data.slice(0, Math.ceil(maxItems / 2));
            const tail = data.slice(-Math.floor(maxItems / 2));
            return [...head, chalk_1.default.dim('... (' + (data.length - maxItems) + ' more items) ...'), ...tail];
        }
        if (typeof data === 'string' && data.length > 500) {
            return (data.substring(0, 250) + chalk_1.default.dim('\n\n... (content truncated) ...\n\n') + data.slice(-250));
        }
        return data;
    },
    stripAnsi: (input) => {
        return input
            .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '') // CSI
            .replace(/\x1B\].*?(\x07|\x1B\\)/g, '') // OSC
            .replace(/\x1B[()#;?]./g, '') // ESC + single char
            .replace(/\x1B[PX^_].*?\x1B\\/g, '') // DCS, SOS, PM, APC
            .replace(/\r/g, ''); // Carriage returns
    },
};
exports.sre = {
    analyzeRootCause: (errorMessage) => {
        const sigPath = path.resolve(process.cwd(), 'knowledge/orchestration/error-signatures.json');
        const results = [];
        if (fs.existsSync(sigPath)) {
            try {
                const signatures = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
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
            }
            catch (_) { }
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
class Cache {
    _maxSize;
    _ttlMs;
    _persistenceDir;
    _map;
    _stats;
    constructor(maxSize = 100, ttlMs = 3600000, persistenceDir) {
        this._maxSize = maxSize;
        this._ttlMs = ttlMs;
        this._persistenceDir = persistenceDir || path.join(process.cwd(), 'active/shared/cache');
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
        if (this._map.size === 0)
            return;
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
        if (!this._stats.purges)
            this._stats.purges = 0;
        this._stats.purges++;
    }
    get(key) {
        const entry = this._map.get(key);
        if (!entry) {
            const diskPath = this._getDiskPath(key);
            const v8Path = diskPath.replace('.json', '.v8');
            if (fs.existsSync(v8Path)) {
                try {
                    const v8Entry = v8.deserialize(fs.readFileSync(v8Path));
                    if (Date.now() - v8Entry.timestamp < v8Entry.ttl) {
                        const actualHash = this._generateHash(v8Entry.value);
                        if (actualHash === v8Entry.h) {
                            this._stats.hits++;
                            this.set(key, v8Entry.value, v8Entry.ttl, false);
                            return v8Entry.value;
                        }
                    }
                    fs.unlinkSync(v8Path);
                }
                catch (_) { }
            }
            if (fs.existsSync(diskPath)) {
                try {
                    const diskEntry = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
                    if (diskEntry.h) {
                        const actualHash = this._generateHash(diskEntry.value);
                        if (actualHash !== diskEntry.h) {
                            this._stats.integrityFailures++;
                            fs.unlinkSync(diskPath);
                            return undefined;
                        }
                    }
                    if (Date.now() - diskEntry.timestamp < diskEntry.ttl) {
                        this._stats.hits++;
                        this.set(key, diskEntry.value, diskEntry.ttl, false);
                        return diskEntry.value;
                    }
                    else {
                        fs.unlinkSync(diskPath);
                    }
                }
                catch (_) { }
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
    set(key, value, customTtlMs, persist = false) {
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
        if (this._map.has(key))
            this._map.delete(key);
        if (this._map.size >= this._maxSize) {
            const lruKey = this._map.keys().next().value;
            if (lruKey !== undefined)
                this._map.delete(lruKey);
        }
        this._map.set(key, { value, timestamp, ttl, persistent: persist });
        if (persist) {
            const diskPath = this._getDiskPath(key);
            const v8Path = diskPath.replace('.json', '.v8');
            try {
                if (!fs.existsSync(this._persistenceDir))
                    fs.mkdirSync(this._persistenceDir, { recursive: true });
                const hash = this._generateHash(value);
                const entry = { value, timestamp, ttl, h: hash };
                fs.writeFileSync(v8Path, v8.serialize(entry));
                fs.writeFileSync(diskPath, JSON.stringify(entry), 'utf8');
            }
            catch (_) { }
        }
    }
    _generateHash(data) {
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
            return (0, node_crypto_1.createHash)('md5').update(combined).digest('hex').substring(0, 8) + 'S';
        }
        return (0, node_crypto_1.createHash)('md5').update(buf).digest('hex').substring(0, 8);
    }
    _getDiskPath(key) {
        const safeKey = key.replace(/[^a-z0-9]/gi, '_').substring(0, 100);
        return path.join(this._persistenceDir, safeKey + '.cache.json');
    }
    has(key) {
        const entry = this._map.get(key);
        if (!entry)
            return false;
        if (Date.now() - entry.timestamp > entry.ttl) {
            this._map.delete(key);
            return false;
        }
        return true;
    }
    clear() { this._map.clear(); }
    get size() { return this._map.size; }
}
exports.Cache = Cache;
exports._fileCache = new Cache(200, 3600000);
const errorHandler = (err, context = '') => {
    exports.logger.error(context + ': ' + (err.message || err));
    if (process.env.DEBUG)
        console.error(err.stack);
    process.exit(1);
};
exports.errorHandler = errorHandler;
exports.fileUtils = {
    getCurrentRole: () => {
        const config = exports.fileUtils.getFullRoleConfig();
        return config ? config.active_role || config.role : 'Unknown';
    },
    getFullRoleConfig: () => {
        const mid = process.env.MISSION_ID;
        const priorityPaths = [];
        if (mid)
            priorityPaths.push(path.resolve(process.cwd(), 'active/missions/' + mid + '/role-state.json'));
        priorityPaths.push(path.resolve(process.cwd(), 'active/shared/governance/session.json'));
        priorityPaths.push(path.resolve(process.cwd(), 'knowledge/personal/role-config.json'));
        for (const p of priorityPaths) {
            if (fs.existsSync(p)) {
                const config = exports.fileUtils.readJson(p);
                if (config && (config.active_role || config.role))
                    return config;
            }
        }
        return null;
    },
    ensureDir: (dirPath) => {
        if (!fs.existsSync(dirPath))
            fs.mkdirSync(dirPath, { recursive: true });
    },
    readJson: (filePath) => {
        try {
            const resolved = path.resolve(filePath);
            const stat = fs.statSync(resolved);
            const mtimeMs = stat.mtimeMs;
            const cached = exports._fileCache.get(resolved);
            if (cached && cached.mtimeMs === mtimeMs)
                return cached.data;
            const content = fs.readFileSync(resolved, 'utf8');
            const data = JSON.parse(content);
            if (stat.size < 5 * 1024 * 1024) {
                const isIndex = resolved.includes('global_skill_index.json');
                exports._fileCache.set(resolved, { mtimeMs, data }, undefined, isIndex);
            }
            return data;
        }
        catch (_) {
            return null;
        }
    },
    writeJson: (filePath, data) => {
        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        }
        catch (err) {
            (0, exports.errorHandler)(err, 'fileUtils.writeJson');
        }
    },
    getGoldenRule: () => {
        const rulePath = path.resolve(process.cwd(), 'vision/_default.md');
        if (fs.existsSync(rulePath)) {
            return fs.readFileSync(rulePath, 'utf8');
        }
        return 'Logic is a Hygiene Factor. Vision is the Compass.';
    },
};
