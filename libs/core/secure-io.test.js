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
const vitest_1 = require("vitest");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const secure_io_js_1 = require("./secure-io.js");
(0, vitest_1.describe)('secure-io core', () => {
    let tmpDir;
    (0, vitest_1.beforeEach)(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-io-test-'));
    });
    (0, vitest_1.afterEach)(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
    (0, vitest_1.describe)('validateFileSize', () => {
        (0, vitest_1.it)('should return size for a small file', () => {
            const testFile = path.join(tmpDir, 'small.txt');
            fs.writeFileSync(testFile, 'Hello, World!');
            const size = (0, secure_io_js_1.validateFileSize)(testFile);
            (0, vitest_1.expect)(size).toBe(13);
        });
        (0, vitest_1.it)('should throw for oversized file', () => {
            const testFile = path.join(tmpDir, 'large.txt');
            fs.writeFileSync(testFile, 'x'.repeat(100));
            (0, vitest_1.expect)(() => (0, secure_io_js_1.validateFileSize)(testFile, 0.00001)).toThrow('File too large');
        });
    });
    (0, vitest_1.describe)('safeReadFile', () => {
        (0, vitest_1.it)('should read a valid file', () => {
            const testFile = path.join(tmpDir, 'read.txt');
            fs.writeFileSync(testFile, 'Safe content');
            const content = (0, secure_io_js_1.safeReadFile)(testFile);
            (0, vitest_1.expect)(content.toString()).toBe('Safe content');
        });
        (0, vitest_1.it)('should throw for missing file', () => {
            (0, vitest_1.expect)(() => (0, secure_io_js_1.safeReadFile)(path.join(tmpDir, 'missing.txt'))).toThrow('File not found');
        });
        (0, vitest_1.it)('should throw for empty path', () => {
            (0, vitest_1.expect)(() => (0, secure_io_js_1.safeReadFile)('')).toThrow('Missing required');
        });
    });
    (0, vitest_1.describe)('safeWriteFile', () => {
        (0, vitest_1.it)('should perform atomic write and clean up temp files', () => {
            const testFile = path.join(tmpDir, 'atomic.txt');
            (0, secure_io_js_1.safeWriteFile)(testFile, 'initial');
            (0, vitest_1.expect)(fs.readFileSync(testFile, 'utf8')).toBe('initial');
            (0, secure_io_js_1.safeWriteFile)(testFile, 'updated');
            (0, vitest_1.expect)(fs.readFileSync(testFile, 'utf8')).toBe('updated');
            const files = fs.readdirSync(tmpDir);
            const tempFiles = files.filter(f => f.includes('atomic.txt.tmp'));
            (0, vitest_1.expect)(tempFiles.length).toBe(0);
        });
    });
    (0, vitest_1.describe)('sanitizePath', () => {
        (0, vitest_1.it)('should remove path traversal and leading slashes', () => {
            (0, vitest_1.expect)((0, secure_io_js_1.sanitizePath)('../etc/passwd')).toBe('etc/passwd');
            (0, vitest_1.expect)((0, secure_io_js_1.sanitizePath)('..\\windows\\system32')).toBe('windows\\system32');
            (0, vitest_1.expect)((0, secure_io_js_1.sanitizePath)('/absolute/path')).toBe('absolute/path');
            (0, vitest_1.expect)((0, secure_io_js_1.sanitizePath)('safe/path/file.txt')).toBe('safe/path/file.txt');
        });
        (0, vitest_1.it)('should remove null bytes', () => {
            (0, vitest_1.expect)((0, secure_io_js_1.sanitizePath)('file\0name.txt')).toBe('filename.txt');
        });
        (0, vitest_1.it)('should handle empty or null input', () => {
            (0, vitest_1.expect)((0, secure_io_js_1.sanitizePath)('')).toBe('');
            (0, vitest_1.expect)((0, secure_io_js_1.sanitizePath)(null)).toBe('');
        });
    });
    (0, vitest_1.describe)('validateUrl', () => {
        (0, vitest_1.it)('should accept valid HTTPS URL', () => {
            const url = 'https://example.com/api';
            (0, vitest_1.expect)((0, secure_io_js_1.validateUrl)(url)).toBe(url);
        });
        (0, vitest_1.it)('should block localhost and loopback', () => {
            (0, vitest_1.expect)(() => (0, secure_io_js_1.validateUrl)('http://localhost:3000')).toThrow('Blocked URL');
            (0, vitest_1.expect)(() => (0, secure_io_js_1.validateUrl)('http://127.0.0.1:8080')).toThrow('Blocked URL');
        });
        (0, vitest_1.it)('should block private IP ranges', () => {
            (0, vitest_1.expect)(() => (0, secure_io_js_1.validateUrl)('http://10.0.0.1')).toThrow('Blocked URL');
            (0, vitest_1.expect)(() => (0, secure_io_js_1.validateUrl)('http://192.168.1.1')).toThrow('Blocked URL');
            (0, vitest_1.expect)(() => (0, secure_io_js_1.validateUrl)('http://172.16.0.1')).toThrow('Blocked URL');
        });
        (0, vitest_1.it)('should reject non-HTTP protocols', () => {
            (0, vitest_1.expect)(() => (0, secure_io_js_1.validateUrl)('ftp://example.com')).toThrow('Unsupported protocol');
        });
        (0, vitest_1.it)('should reject invalid URLs', () => {
            (0, vitest_1.expect)(() => (0, secure_io_js_1.validateUrl)('not-a-url')).toThrow('Invalid URL');
        });
        (0, vitest_1.it)('should throw for empty input', () => {
            (0, vitest_1.expect)(() => (0, secure_io_js_1.validateUrl)('')).toThrow('Missing or invalid URL');
        });
    });
});
//# sourceMappingURL=secure-io.test.js.map