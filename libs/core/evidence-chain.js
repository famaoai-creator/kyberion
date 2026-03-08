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
exports.evidenceChain = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const pathResolver = __importStar(require("./path-resolver.js"));
const secure_io_js_1 = require("./secure-io.js");
/**
 * Chain of Evidence: The Blockchain of Artifacts
 * [SECURE-IO COMPLIANT VERSION]
 */
exports.evidenceChain = {
    registryPath: pathResolver.shared('registry/evidence_chain.json'),
    register: (filePath, agentId, parentId = null, context = '') => {
        if (!fs.existsSync(filePath))
            return null;
        try {
            const content = (0, secure_io_js_1.safeReadFile)(filePath);
            const hash = (0, node_crypto_1.createHash)('sha256').update(content).digest('hex');
            const id = `EVD-${hash.substring(0, 8).toUpperCase()}`;
            const entry = {
                id,
                path: path.relative(pathResolver.active(), filePath),
                hash,
                agentId,
                parentId,
                context,
                timestamp: new Date().toISOString(),
            };
            const registry = exports.evidenceChain._loadRegistry();
            if (!registry.chain.find((e) => e.hash === hash)) {
                registry.chain.push(entry);
                (0, secure_io_js_1.safeWriteFile)(exports.evidenceChain.registryPath, JSON.stringify(registry, null, 2));
            }
            return id;
        }
        catch (err) {
            return null;
        }
    },
    getLineage: (evidenceId) => {
        const registry = exports.evidenceChain._loadRegistry();
        const lineage = [];
        let currentId = evidenceId;
        while (currentId) {
            const entry = registry.chain.find((e) => e.id === currentId);
            if (!entry)
                break;
            lineage.push(entry);
            currentId = entry.parentId;
        }
        return lineage.reverse();
    },
    _loadRegistry: () => {
        if (!fs.existsSync(exports.evidenceChain.registryPath)) {
            return { chain: [] };
        }
        try {
            // Use standard fs for internal loading within library if necessary, 
            // but safeReadFile is preferred if accessible.
            const content = fs.readFileSync(exports.evidenceChain.registryPath, 'utf8');
            return JSON.parse(content);
        }
        catch (_) {
            return { chain: [] };
        }
    },
};
//# sourceMappingURL=evidence-chain.js.map