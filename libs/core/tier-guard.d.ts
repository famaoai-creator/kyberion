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
import type { TierLevel, TierWeightMap, TierValidation, MarkerScanResult } from './types.js';
/** Numeric weight for each tier (higher = more sensitive). */
export declare const TIERS: TierWeightMap;
/**
 * Determine the knowledge tier of a file based on its path.
 */
export declare function detectTier(filePath: string): TierLevel;
/**
 * Check whether data from `sourceTier` is allowed to flow into `targetTier` output.
 */
export declare function canFlowTo(sourceTier: TierLevel, targetTier: TierLevel): boolean;
/**
 * Validate that a knowledge file can be injected into output at the given tier.
 */
export declare function validateInjection(knowledgePath: string, outputTier: TierLevel): TierValidation;
/**
 * Validates read permission based on role and tier.
 */
export declare function validateReadPermission(filePath: string): {
    allowed: boolean;
    reason?: string;
};
/**
 * Validates write permission based on role and tier.
 */
export declare function validateWritePermission(filePath: string): {
    allowed: boolean;
    reason?: string;
};
/**
 * Scan text content for patterns that suggest sensitive / confidential data.
 */
export declare function scanForConfidentialMarkers(content: string): MarkerScanResult;
//# sourceMappingURL=tier-guard.d.ts.map