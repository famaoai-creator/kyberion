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
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeUnlink = exports.safeAppendFile = exports.DEFAULT_TIMEOUT_MS = exports.DEFAULT_MAX_FILE_SIZE_MB = void 0;
exports.validateFileSize = validateFileSize;
exports.safeReadFile = safeReadFile;
exports.safeWriteFile = safeWriteFile;
exports.safeAppendFileSync = safeAppendFileSync;
exports.safeUnlinkSync = safeUnlinkSync;
exports.safeMkdir = safeMkdir;
exports.safeExec = safeExec;
exports.validateUrl = validateUrl;
exports.sanitizePath = sanitizePath;
exports.writeArtifact = writeArtifact;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const pathResolver = __importStar(require("./path-resolver.js"));
const tier_guard_js_1 = require("./tier-guard.js");
/**
 * Secure I/O utilities for Kyberion Ecosystem (TypeScript Edition)
 * Provides file size validation, safe command execution, and resource guards.
 */
exports.DEFAULT_MAX_FILE_SIZE_MB = 100;
exports.DEFAULT_TIMEOUT_MS = 30000;
/**
 * Validate that a file does not exceed a size limit.
 */
function validateFileSize(filePath, maxSizeMB = exports.DEFAULT_MAX_FILE_SIZE_MB) {
    const resolved = pathResolver.resolve(filePath);
    const stat = fs.statSync(resolved);
    const sizeMB = stat.size / (1024 * 1024);
    if (sizeMB > maxSizeMB) {
        throw new Error(`File too large: ${resolved} is ${sizeMB.toFixed(1)}MB (limit: ${maxSizeMB}MB)`);
    }
    return stat.size;
}
/**
 * Read a file with size validation and optional caching.
 */
function safeReadFile(filePath, options = {}) {
    const { maxSizeMB = exports.DEFAULT_MAX_FILE_SIZE_MB, encoding = 'utf8', label = 'input', cache = true, } = options;
    if (!filePath) {
        throw new Error(`Missing required ${label} file path`);
    }
    const resolved = pathResolver.resolve(filePath);
    const guard = (0, tier_guard_js_1.validateReadPermission)(resolved);
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
function safeWriteFile(filePath, data, options = {}) {
    const { mkdir = true } = options;
    const resolved = pathResolver.resolve(filePath);
    const guard = (0, tier_guard_js_1.validateWritePermission)(resolved);
    if (!guard.allowed) {
        throw new Error(guard.reason);
    }
    const dir = path.dirname(resolved);
    if (mkdir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const ns = process.hrtime.bigint().toString();
    const tempPath = `${resolved}.tmp.${ns}.${Math.random().toString(36).substring(2)}`;
    let fd = null;
    try {
        fd = fs.openSync(tempPath, 'w');
        fs.writeFileSync(fd, data, options);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tempPath, resolved);
    }
    catch (err) {
        if (fd !== null)
            try {
                fs.closeSync(fd);
            }
            catch (_) { }
        if (fs.existsSync(tempPath))
            try {
                fs.unlinkSync(tempPath);
            }
            catch (_) { }
        throw err;
    }
}
/**
 * Append to a file safely.
 */
function safeAppendFileSync(filePath, data, options = 'utf8') {
    const resolved = pathResolver.resolve(filePath);
    const guard = (0, tier_guard_js_1.validateWritePermission)(resolved);
    if (!guard.allowed)
        throw new Error(guard.reason);
    fs.appendFileSync(resolved, data, options);
}
/**
 * Unlink a file safely.
 */
function safeUnlinkSync(filePath) {
    const resolved = pathResolver.resolve(filePath);
    const guard = (0, tier_guard_js_1.validateWritePermission)(resolved);
    if (!guard.allowed)
        throw new Error(guard.reason);
    if (fs.existsSync(resolved))
        fs.unlinkSync(resolved);
}
/**
 * Create a directory safely.
 */
function safeMkdir(dirPath, options = { recursive: true }) {
    const resolved = pathResolver.resolve(dirPath);
    const guard = (0, tier_guard_js_1.validateWritePermission)(resolved);
    if (!guard.allowed)
        throw new Error(guard.reason);
    if (!fs.existsSync(resolved)) {
        fs.mkdirSync(resolved, options);
    }
}
/**
 * Execute a command safely.
 */
function safeExec(command, args = [], options = {}) {
    const { timeoutMs = exports.DEFAULT_TIMEOUT_MS, cwd = process.cwd(), encoding = 'utf8', maxOutputMB = 10, } = options;
    return (0, node_child_process_1.execFileSync)(command, args, {
        encoding,
        cwd,
        timeout: timeoutMs,
        maxBuffer: maxOutputMB * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}
/**
 * Validate a URL against SSRF and protocol restrictions.
 */
function validateUrl(url) {
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
    }
    catch (err) {
        if (err.message.includes('Blocked URL') || err.message.includes('Unsupported protocol')) {
            throw err;
        }
        throw new Error(`Invalid URL: ${url}`);
    }
}
/**
 * Sanitize a string for safe use in file paths.
 */
function sanitizePath(input) {
    if (!input || typeof input !== 'string')
        return '';
    return input
        .replace(/\0/g, '')
        .replace(/\.\.\//g, '')
        .replace(/\.\.\\/g, '')
        .replace(/^[/\\]+/, '');
}
/**
 * Writes an artifact and returns a HAP.
 */
function writeArtifact(filePath, data, format) {
    const hash = (0, node_crypto_1.createHash)('sha256').update(data).digest('hex');
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
exports.safeAppendFile = safeAppendFileSync;
exports.safeUnlink = safeUnlinkSync;
