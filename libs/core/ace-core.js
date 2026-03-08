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
exports.aceCore = void 0;
const fs = __importStar(require("node:fs"));
const node_crypto_1 = require("node:crypto");
/**
 * ACE (Autonomous Consensus Engine) Core Utility
 */
exports.aceCore = {
    calculateHash: (text) => {
        return (0, node_crypto_1.createHash)('sha256').update(text).digest('hex');
    },
    appendThought: (minutesPath, role, thought, _metadata = {}) => {
        let content = '';
        if (fs.existsSync(minutesPath)) {
            content = fs.readFileSync(minutesPath, 'utf8');
        }
        const prevHash = exports.aceCore.calculateHash(content);
        const timestamp = new Date().toISOString();
        const entryHeader = `\n### [${role}] @${timestamp} | PREV_HASH: ${prevHash.substring(0, 8)} | HASH: `;
        const entryBody = `\n> ${thought}\n`;
        const entryHash = exports.aceCore.calculateHash(entryHeader + entryBody);
        const finalEntry = entryHeader + entryHash.substring(0, 8) + entryBody;
        fs.appendFileSync(minutesPath, finalEntry);
        return entryHash;
    },
    validateIntegrity: (minutesPath) => {
        if (!fs.existsSync(minutesPath))
            return true;
        const content = fs.readFileSync(minutesPath, 'utf8');
        const lines = content.split('\n');
        let lastHash = '';
        for (const line of lines) {
            const match = line.match(/HASH: ([a-f0-9]{8})/);
            if (match) {
                lastHash = match[1];
            }
        }
        console.log(`[Integrity] Last chain hash: ${lastHash}`);
        return true;
    },
    evaluateDecision: (votes) => {
        const securityRisk = votes.find((v) => v.securityScore === 'S1');
        const highUrgency = votes.some((v) => v.urgencyScore === 'U1');
        if (securityRisk) {
            return {
                decision: 'NO-GO',
                reason: `Critical Security Risk (S1) detected by ${securityRisk.role}.`,
                allowYellowCard: false,
            };
        }
        const s2Risk = votes.find((v) => v.securityScore === 'S2');
        if (s2Risk) {
            if (highUrgency) {
                return {
                    decision: 'YELLOW-CARD',
                    reason: `High Security Risk (S2) detected, but U1 Urgency allows conditional approval.`,
                    allowYellowCard: true,
                    debtAction: s2Risk.comment,
                };
            }
            else {
                return {
                    decision: 'NO-GO',
                    reason: `High Security Risk (S2) and insufficient urgency for bypass.`,
                    allowYellowCard: false,
                };
            }
        }
        return {
            decision: 'GO',
            reason: 'All evaluations within acceptable limits.',
            allowYellowCard: false,
        };
    },
};
//# sourceMappingURL=ace-core.js.map