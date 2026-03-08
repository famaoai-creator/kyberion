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
exports.ledger = exports.verifyIntegrity = exports.record = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
/**
 * Ecosystem Ledger v1.0
 * Provides a centralized, tamper-evident audit trail for all governance events.
 */
const LEDGER_PATH = path.join(process.cwd(), 'active/audit/governance-ledger.jsonl');
const record = (type, data) => {
    const timestamp = new Date().toISOString();
    const lastHash = _getLastHash();
    const entry = {
        timestamp,
        type,
        role: data.role || 'Unknown',
        mission_id: data.mission_id || 'None',
        payload: data,
        parent_hash: lastHash,
    };
    const hash = (0, node_crypto_1.createHash)('sha256').update(JSON.stringify(entry)).digest('hex');
    entry.hash = hash;
    if (!fs.existsSync(path.dirname(LEDGER_PATH))) {
        fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
    }
    fs.appendFileSync(LEDGER_PATH, JSON.stringify(entry) + '\n');
    return hash;
};
exports.record = record;
function _getLastHash() {
    if (!fs.existsSync(LEDGER_PATH))
        return '0'.repeat(64);
    try {
        const content = fs.readFileSync(LEDGER_PATH, 'utf8').trim();
        if (!content)
            return '0'.repeat(64);
        const lines = content.split('\n');
        const lastEntry = JSON.parse(lines[lines.length - 1]);
        return lastEntry.hash || '0'.repeat(64);
    }
    catch (_e) {
        return '0'.repeat(64);
    }
}
/**
 * Verify the integrity of the entire ledger
 */
const verifyIntegrity = () => {
    if (!fs.existsSync(LEDGER_PATH))
        return true;
    const lines = fs.readFileSync(LEDGER_PATH, 'utf8').trim().split('\n');
    let expectedParentHash = '0'.repeat(64);
    for (const line of lines) {
        if (!line)
            continue;
        try {
            const entry = JSON.parse(line);
            const { hash, ...dataWithoutHash } = entry;
            if (entry.parent_hash !== expectedParentHash)
                return false;
            const actualHash = (0, node_crypto_1.createHash)('sha256')
                .update(JSON.stringify(dataWithoutHash))
                .digest('hex');
            if (hash !== actualHash)
                return false;
            expectedParentHash = hash;
        }
        catch (_e) {
            return false;
        }
    }
    return true;
};
exports.verifyIntegrity = verifyIntegrity;
// Legacy support
exports.ledger = { record: exports.record, verifyIntegrity: exports.verifyIntegrity };
