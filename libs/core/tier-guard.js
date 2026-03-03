"use strict";
/**
 * TypeScript version of the Knowledge Tier Guard.
 *
 * Prevents confidential / personal data from leaking into lower-tier outputs.
 *
 * Tier hierarchy (higher number = more sensitive):
 *   personal (3) > confidential (2) > public (1)
 *
 * Data from a higher tier must never appear in a lower-tier output.
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
exports.canFlowTo = canFlowTo;
exports.validateInjection = validateInjection;
exports.validateReadPermission = validateReadPermission;
exports.validateWritePermission = validateWritePermission;
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
 * Validates read permission based on role and tier.
 */
function validateReadPermission(filePath) {
    const tier = detectTier(filePath);
    // Default allow for now, but can be restricted by role later
    return { allowed: true };
}
/**
 * Validates write permission based on role and tier.
 */
function validateWritePermission(filePath) {
    const tier = detectTier(filePath);
    if (tier === 'personal') {
        return { allowed: false, reason: 'Writing to personal tier is restricted.' };
    }
    return { allowed: true };
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
//# sourceMappingURL=tier-guard.js.map