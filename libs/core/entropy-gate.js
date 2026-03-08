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
exports.entropyGate = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const CACHE_DIR = path.join(process.cwd(), 'active/shared/entropy-cache');
/**
 * Entropy Gate v1.0
 * Allows the agent to detect if the environment has changed.
 */
exports.entropyGate = {
    /**
     * Compare the given data with its last seen state.
     * If identical, returns false (Gate Closed - Sleep).
     * If changed, updates cache and returns true (Gate Open - Process).
     */
    shouldWake(key, data) {
        if (!fs.existsSync(CACHE_DIR)) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
        }
        const hashPath = path.join(CACHE_DIR, `${key}.hash`);
        const currentData = typeof data === 'string' ? data : JSON.stringify(data);
        const currentHash = (0, node_crypto_1.createHash)('md5').update(currentData).digest('hex');
        if (fs.existsSync(hashPath)) {
            const lastHash = fs.readFileSync(hashPath, 'utf8');
            if (lastHash === currentHash) {
                return false; // No change, stay in sleep
            }
        }
        // Environmental change detected
        fs.writeFileSync(hashPath, currentHash);
        return true;
    },
    /**
     * Reset the gate for a specific key.
     */
    reset(key) {
        const hashPath = path.join(CACHE_DIR, `${key}.hash`);
        if (fs.existsSync(hashPath))
            fs.unlinkSync(hashPath);
    }
};
//# sourceMappingURL=entropy-gate.js.map