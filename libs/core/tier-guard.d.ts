/**
 * TypeScript version of the Knowledge Tier Guard.
 * v2.0 - HARDENED ROLE-BASED ACCESS CONTROL (RBAC)
 */
import type { TierLevel, TierWeightMap, TierValidation, MarkerScanResult } from './types.js';
export { TierLevel, TierWeightMap, TierValidation, MarkerScanResult };
/** Numeric weight for each tier (higher = more sensitive). */
export declare const TIERS: TierWeightMap;
/**
 * Determine the knowledge tier of a file based on its path.
 */
export declare function detectTier(filePath: string): TierLevel;
/**
 * Validates write permission based on CURRENT ROLE and target path.
 * This is the CORE of the Hardened Role Guard.
 */
export declare function validateWritePermission(filePath: string): {
    allowed: boolean;
    reason?: string;
};
/**
 * Existing Legacy Guard Functions (Restored for compatibility)
 */
export declare function detectTenant(filePath: string): string | null;
export declare function validateReadPermission(filePath: string): {
    allowed: boolean;
    reason?: string;
};
export declare function validateSovereignBoundary(content: string, activeSecrets?: string[]): {
    safe: boolean;
    detected: string[];
};
export declare function scanForConfidentialMarkers(content: string): MarkerScanResult;
//# sourceMappingURL=tier-guard.d.ts.map