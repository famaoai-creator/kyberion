"use strict";
/**
 * TypeScript version of the Knowledge Tier Guard.
 *
 * Prevents confidential / personal data from leaking into lower-tier outputs.
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
exports.detectTenant = detectTenant;
exports.canFlowTo = canFlowTo;
exports.validateInjection = validateInjection;
exports.validateReadPermission = validateReadPermission;
exports.validateWritePermission = validateWritePermission;
exports.validateSovereignBoundary = validateSovereignBoundary;
exports.scanForConfidentialMarkers = scanForConfidentialMarkers;
const path = __importStar(require("node:path"));
/** Numeric weight for each tier (higher = more sensitive). */
exports.TIERS = {
    personal: 3,
    confidential: 2,
    public: 1,
};
const KNOWLEDGE_ROOT = path.join(process.cwd(), 'knowledge');
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
 * Extract tenant name from physical path (e.g., vault/{Tenant}/...)
 */
function detectTenant(filePath) {
    const resolved = path.resolve(filePath);
    const vaultRoot = path.resolve(process.cwd(), 'vault');
    if (resolved.startsWith(vaultRoot)) {
        const relative = path.relative(vaultRoot, resolved);
        const parts = relative.split(path.sep);
        return parts.length > 0 ? parts[0] : null;
    }
    return null;
}
/**
 * Check whether data from `sourceTier` is allowed to flow into `targetTier` output.
 */
function canFlowTo(sourceTier, targetTier) {
    return exports.TIERS[sourceTier] <= exports.TIERS[targetTier];
}
/**
 * Validate that a knowledge file can be injected into output at the given tier.
 */
function validateInjection(knowledgePath, outputTier) {
    const sourceTier = detectTier(knowledgePath);
    const allowed = canFlowTo(sourceTier, outputTier);
    const result = { allowed, sourceTier, outputTier };
    if (!allowed) {
        result.reason = `Cannot inject ${sourceTier}-tier data into ${outputTier}-tier output`;
    }
    return result;
}
/**
 * Validates read permission based on role, tier and tenant.
 */
function validateReadPermission(filePath) {
    const tenant = detectTenant(filePath);
    const activeTenant = process.env.ACTIVE_TENANT;
    if (tenant && activeTenant && tenant !== activeTenant) {
        return {
            allowed: false,
            reason: `[TENANT_VIOLATION] Access to tenant '${tenant}' data is denied while active tenant is '${activeTenant}'.`
        };
    }
    return { allowed: true };
}
/**
 * Validates write permission based on role, tier and tenant.
 */
function validateWritePermission(filePath) {
    const tier = detectTier(filePath);
    const tenant = detectTenant(filePath);
    const activeTenant = process.env.ACTIVE_TENANT;
    if (tier === 'personal') {
        return { allowed: false, reason: 'Writing to personal tier is restricted.' };
    }
    if (tenant && activeTenant && tenant !== activeTenant) {
        return {
            allowed: false,
            reason: `[TENANT_VIOLATION] Writing to tenant '${tenant}' data is denied while active tenant is '${activeTenant}'.`
        };
    }
    return { allowed: true };
}
/**
 * Validate that content does not cross the Sovereign boundary (no secret leaks).
 * Note: activeSecrets must be passed from secret-guard to avoid circular dependency.
 */
function validateSovereignBoundary(content, activeSecrets = []) {
    const detected = [];
    // 1. Check for active secrets
    for (const secret of activeSecrets) {
        if (content.includes(secret)) {
            detected.push(`SECRET_LEAK: ${secret.substring(0, 3)}...`);
        }
    }
    // 2. Check for markers
    const markerCheck = scanForConfidentialMarkers(content);
    if (markerCheck.hasMarkers) {
        detected.push(...markerCheck.markers.map(m => `MARKER_DETECTED: ${m}`));
    }
    return {
        safe: detected.length === 0,
        detected,
    };
}
/**
 * Scan text content for patterns that suggest sensitive / confidential data.
 */
function scanForConfidentialMarkers(content) {
    const MARKERS = [
        /CONFIDENTIAL/i,
        /SECRET/i,
        /PRIVATE/i,
        /API[_-]?KEY/i,
        /PASSWORD/i,
        /TOKEN/i,
        /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
    ];
    const found = [];
    for (const pattern of MARKERS) {
        if (pattern.test(content)) {
            found.push(pattern.source);
        }
    }
    return { hasMarkers: found.length > 0, markers: found };
}
