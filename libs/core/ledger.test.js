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
const ledger_js_1 = require("./ledger.js");
// We need to handle the hardcoded LEDGER_PATH in ledger.ts
const LEDGER_FILE = path.join(process.cwd(), 'active/audit/governance-ledger.jsonl');
(0, vitest_1.describe)('ledger core', () => {
    let backupContent = null;
    (0, vitest_1.beforeEach)(() => {
        if (fs.existsSync(LEDGER_FILE)) {
            backupContent = fs.readFileSync(LEDGER_FILE, 'utf8');
        }
        if (!fs.existsSync(path.dirname(LEDGER_FILE))) {
            fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
        }
        fs.writeFileSync(LEDGER_FILE, '');
    });
    (0, vitest_1.afterEach)(() => {
        if (backupContent !== null) {
            fs.writeFileSync(LEDGER_FILE, backupContent);
        }
        else if (fs.existsSync(LEDGER_FILE)) {
            fs.unlinkSync(LEDGER_FILE);
        }
    });
    (0, vitest_1.it)('should record an event and return a valid SHA-256 hash', () => {
        const hash = (0, ledger_js_1.record)('TEST_EVENT', { role: 'tester', data: 'foo' });
        (0, vitest_1.expect)(typeof hash).toBe('string');
        (0, vitest_1.expect)(hash).toHaveLength(64);
        const content = fs.readFileSync(LEDGER_FILE, 'utf8');
        (0, vitest_1.expect)(content).toContain('TEST_EVENT');
        (0, vitest_1.expect)(content).toContain('foo');
    });
    (0, vitest_1.it)('should maintain a valid integrity chain for multiple events', () => {
        (0, ledger_js_1.record)('EVENT_1', { data: 'first' });
        (0, ledger_js_1.record)('EVENT_2', { data: 'second' });
        const isValid = (0, ledger_js_1.verifyIntegrity)();
        (0, vitest_1.expect)(isValid).toBe(true);
    });
    (0, vitest_1.it)('should detect tampering in the ledger file', () => {
        (0, ledger_js_1.record)('SAFE_EVENT', { data: 'original' });
        const content = fs.readFileSync(LEDGER_FILE, 'utf8');
        const tampered = content.replace('original', 'tampered');
        fs.writeFileSync(LEDGER_FILE, tampered);
        const isValid = (0, ledger_js_1.verifyIntegrity)();
        (0, vitest_1.expect)(isValid).toBe(false);
    });
    (0, vitest_1.it)('should detect parent hash mismatch', () => {
        (0, ledger_js_1.record)('E1', { data: '1' });
        (0, ledger_js_1.record)('E2', { data: '2' });
        const lines = fs.readFileSync(LEDGER_FILE, 'utf8').trim().split('\n');
        const entry2 = JSON.parse(lines[1]);
        entry2.parent_hash = 'badhash';
        lines[1] = JSON.stringify(entry2);
        fs.writeFileSync(LEDGER_FILE, lines.join('\n') + '\n');
        (0, vitest_1.expect)((0, ledger_js_1.verifyIntegrity)()).toBe(false);
    });
});
//# sourceMappingURL=ledger.test.js.map