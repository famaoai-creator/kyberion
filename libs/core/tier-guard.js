"use strict";
/**
 * TypeScript version of the Knowledge Tier Guard.
 * v2.0 - HARDENED ROLE-BASED ACCESS CONTROL (RBAC)
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
/** Numeric weight for each tier (higher = more sensitive). */
exports.TIERS = {
    personal: 4,
    confidential: 3,
    public: 1,
};
const ROOT_DIR = process.cwd();
const KNOWLEDGE_ROOT = path.join(ROOT_DIR, 'knowledge');
const ACCESS_MATRIX_PATH = path.join(KNOWLEDGE_ROOT, 'governance/role-write-access.json');
const TIER_PATHS = {
    personal: path.join(KNOWLEDGE_ROOT, 'personal'),
    confidential: path.join(KNOWLEDGE_ROOT, 'confidential'),
    public: KNOWLEDGE_ROOT,
};
/**
 * Determine the knowledge tier of a file based on its path.
 */
function detectTier(filePath) {
    const resolved = path.resolve(filePath);
    if (resolved.startsWith(path.resolve(TIER_PATHS.personal)))
        return 'personal';
    if (resolved.startsWith(path.resolve(TIER_PATHS.confidential)))
        return 'confidential';
    return 'public';
}
/**
 * Validates write permission based on CURRENT ROLE and target path.
 * This is the CORE of the Hardened Role Guard.
 */
function validateWritePermission(filePath) {
    const resolvedPath = path.resolve(filePath);
    const currentMission = process.env.MISSION_ID;
    // 1. Identify Current Role from physical state or environment
    let currentRole = 'unknown';
    const envRole = process.env.MISSION_ROLE;
    if (currentMission) {
        const statePath = path.join(ROOT_DIR, 'active/missions', currentMission, 'mission-state.json');
        try {
            if (fs.existsSync(statePath)) {
                const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                currentRole = (state.assigned_persona || 'unknown').toLowerCase().replace(/\s+/g, '_');
            }
        }
        catch (_) { }
    }
    // Fallback to environment role if unknown (crucial for mission bootstrap)
    if (currentRole === 'unknown' && envRole) {
        currentRole = envRole.toLowerCase().replace(/\s+/g, '_');
    }
    // 2. Load Role-Based Access Matrix
    let matrix = null;
    try {
        if (fs.existsSync(ACCESS_MATRIX_PATH)) {
            matrix = JSON.parse(fs.readFileSync(ACCESS_MATRIX_PATH, 'utf8'));
        }
    }
    catch (_) { }
    if (!matrix)
        return { allowed: true }; // Fallback to permissive if matrix missing (to avoid bootstrap deadlock)
    // 3. Evaluate Permissions
    const relativePath = path.relative(ROOT_DIR, resolvedPath);
    // A. Check Default Allowed (Mission Dir, Scratch, etc.)
    const defaultAllow = matrix.default_allow.map((p) => p.replace('${MISSION_ID}', currentMission || 'NONE'));
    if (defaultAllow.some((p) => relativePath.startsWith(p))) {
        return { allowed: true };
    }
    // B. Check Role Specific Allowed
    const roleConfig = matrix.roles[currentRole];
    if (roleConfig && roleConfig.allow) {
        if (roleConfig.allow.some((p) => relativePath.startsWith(p))) {
            return { allowed: true };
        }
    }
    // C. Special Privilege: Ecosystem Architect can write almost anywhere in Public Tier
    if (currentRole === 'ecosystem_architect' && relativePath.startsWith('knowledge/')) {
        return { allowed: true };
    }
    return {
        allowed: false,
        reason: `[ROLE_VIOLATION] Role '${currentRole}' is NOT authorized to write to '${relativePath}'.`
    };
}
/**
 * Existing Legacy Guard Functions (Restored for compatibility)
 */
function detectTenant(filePath) {
    const resolved = path.resolve(filePath);
    const vaultRoot = path.resolve(ROOT_DIR, 'vault');
    if (resolved.startsWith(vaultRoot)) {
        const relative = path.relative(vaultRoot, resolved);
        return relative.split(path.sep)[0] || null;
    }
    return null;
}
function validateReadPermission(filePath) {
    const tenant = detectTenant(filePath);
    const activeTenant = process.env.ACTIVE_TENANT;
    if (tenant && activeTenant && tenant !== activeTenant) {
        return { allowed: false, reason: `[TENANT_VIOLATION] Read access denied for tenant '${tenant}'.` };
    }
    return { allowed: true };
}
function validateSovereignBoundary(content, activeSecrets = []) {
    const detected = [];
    for (const secret of activeSecrets) {
        if (content.includes(secret))
            detected.push(`SECRET_LEAK: ${secret.substring(0, 3)}...`);
    }
    const markerCheck = scanForConfidentialMarkers(content);
    if (markerCheck.hasMarkers)
        detected.push(...markerCheck.markers.map(m => `MARKER_DETECTED: ${m}`));
    return { safe: detected.length === 0, detected };
}
function scanForConfidentialMarkers(content) {
    const MARKERS = [/CONFIDENTIAL/i, /SECRET/i, /PRIVATE/i, /API[_-]?KEY/i, /PASSWORD/i, /TOKEN/i, /Bearer\s+[A-Za-z0-9\-._~+/]+=*/];
    const found = [];
    for (const pattern of MARKERS) {
        if (pattern.test(content))
            found.push(pattern.source);
    }
    return { hasMarkers: found.length > 0, markers: found };
}
