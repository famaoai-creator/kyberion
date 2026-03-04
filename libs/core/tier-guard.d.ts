/**
 * TypeScript version of the Knowledge Tier Guard.
 *
 * Prevents confidential / personal data from leaking into lower-tier outputs.
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
 * Extract tenant name from physical path (e.g., vault/{Tenant}/...)
 */
export declare function detectTenant(filePath: string): string | null;
/**
 * Check whether data from `sourceTier` is allowed to flow into `targetTier` output.
 */
export declare function canFlowTo(sourceTier: TierLevel, targetTier: TierLevel): boolean;
/**
 * Validate that a knowledge file can be injected into output at the given tier.
 */
export declare function validateInjection(knowledgePath: string, outputTier: TierLevel): TierValidation;
/**
 * Validates read permission based on role, tier and tenant.
 */
export declare function validateReadPermission(filePath: string): {
    allowed: boolean;
    reason?: string;
};
/**
 * Validates write permission based on role, tier and tenant.
 */
export declare function validateWritePermission(filePath: string): {
    allowed: boolean;
    reason?: string;
};
/**
 * Validate that content does not cross the Sovereign boundary (no secret leaks).
 * Note: activeSecrets must be passed from secret-guard to avoid circular dependency.
 */
export declare function validateSovereignBoundary(content: string, activeSecrets?: string[]): {
    safe: boolean;
    detected: string[];
};
/**
 * Scan text content for patterns that suggest sensitive / confidential data.
 */
export declare function scanForConfidentialMarkers(content: string): MarkerScanResult;
//# sourceMappingURL=tier-guard.d.ts.map