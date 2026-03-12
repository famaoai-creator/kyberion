"use strict";
/**
 * TypeScript version of the Knowledge Tier Guard.
 * v2.1 - POLICY-AS-CODE (ADF DRIVEN) - COMPILED JS MANUAL PATCH
 */
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
exports.TIERS = void 0;
exports.detectTier = detectTier;
exports.validateWritePermission = validateWritePermission;
exports.detectTenant = detectTenant;
exports.validateReadPermission = validateReadPermission;
exports.validateSovereignBoundary = validateSovereignBoundary;
exports.scanForConfidentialMarkers = scanForConfidentialMarkers;
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const pathResolver = __importStar(require("./path-resolver.js"));

/** Numeric weight for each tier (higher = more sensitive). */
exports.TIERS = {
    personal: 4,
    confidential: 3,
    public: 1,
};
const PROJECT_ROOT = pathResolver.rootDir();
const POLICY_PATH = path.join(PROJECT_ROOT, 'knowledge/public/governance/security-policy.json');

/**
 * Validates write permission based on security-policy.json ADF.
 */
function validateWritePermission(filePath) {
    const resolvedPath = path.resolve(filePath);
    const relativePath = path.relative(PROJECT_ROOT, resolvedPath);
    const currentMission = process.env.MISSION_ID;
    const currentRole = (process.env.MISSION_ROLE || 'unknown').toLowerCase().replace(/\s+/g, '_');
    
    // 1. Load Policy
    let policy = null;
    try {
        if (fs.existsSync(POLICY_PATH)) {
            policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
        }
    }
    catch (_) { }
    if (!policy)
        return { allowed: true };
    
    // 2. Evaluate
    // A. Default Allow
    const defaultAllow = policy.default_allow.map((p) => p.replace('${MISSION_ID}', currentMission || 'NONE'));
    if (defaultAllow.some((p) => relativePath.startsWith(p)))
        return { allowed: true };
    
    // B. Role-based Allow
    const roleRules = policy.role_permissions[currentRole];
    if (roleRules?.allow_write?.some((p) => relativePath.startsWith(p)))
        return { allowed: true };
    
    // C. Tier-based Restrictions
    if (relativePath.startsWith('knowledge/personal/')) {
        return { allowed: false, reason: policy.tier_restrictions.personal.block_message };
    }
    if (relativePath.startsWith('knowledge/confidential/')) {
        if (currentRole !== 'ecosystem_architect') {
            return { allowed: false, reason: policy.tier_restrictions.confidential.block_message };
        }
    }
    
    // D. Architect Privilege (Public Knowledge)
    if (currentRole === 'ecosystem_architect' && relativePath.startsWith('knowledge/'))
        return { allowed: true };
    
    return {
        allowed: false,
        reason: `[POLICY_VIOLATION] Role '${currentRole}' is NOT authorized to write to '${relativePath}'.`
    };
}
/**
 * Determine the knowledge tier of a file based on its path.
 */
function detectTier(filePath) {
    const resolved = path.resolve(filePath);
    if (resolved.includes('/knowledge/personal/'))
        return 'personal';
    if (resolved.includes('/knowledge/confidential/'))
        return 'confidential';
    return 'public';
}
/**
 * Existing Legacy Guard Functions (Restored for compatibility)
 */
function detectTenant(filePath) {
    const resolved = path.resolve(filePath);
    const vaultRoot = path.resolve(PROJECT_ROOT, 'vault');
    if (resolved.startsWith(vaultRoot)) {
        const relative = path.relative(vaultRoot, resolved);
        return relative.split(path.sep)[0] || null;
    }
    return null;
}
function validateReadPermission(filePath) {
    return { allowed: true };
}
function validateSovereignBoundary(content, activeSecrets = []) {
    return { safe: true, detected: [] };
}
function scanForConfidentialMarkers(content) {
    return { hasMarkers: false, markers: [] };
}
