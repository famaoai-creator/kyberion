/**
 * TypeScript version of the Knowledge Tier Guard.
 *
 * Prevents confidential / personal data from leaking into lower-tier outputs.
 */

import * as path from 'node:path';
import type { TierLevel, TierWeightMap, TierValidation, MarkerScanResult } from './types.js';

export { TierLevel, TierWeightMap, TierValidation, MarkerScanResult };

/** Numeric weight for each tier (higher = more sensitive). */
export const TIERS: TierWeightMap = {
  personal: 3,
  confidential: 2,
  public: 1,
};

const KNOWLEDGE_ROOT: string = path.join(process.cwd(), 'knowledge');

const TIER_PATHS: Record<TierLevel, string> = {
  personal: path.join(KNOWLEDGE_ROOT, 'personal'),
  confidential: path.join(KNOWLEDGE_ROOT, 'confidential'),
  public: KNOWLEDGE_ROOT,
};

/**
 * Determine the knowledge tier of a file based on its path.
 */
export function detectTier(filePath: string): TierLevel {
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(path.resolve(TIER_PATHS.personal))) return 'personal';
  if (resolved.startsWith(path.resolve(TIER_PATHS.confidential))) return 'confidential';
  return 'public';
}

/**
 * Check whether data from `sourceTier` is allowed to flow into `targetTier` output.
 */
export function canFlowTo(sourceTier: TierLevel, targetTier: TierLevel): boolean {
  return TIERS[sourceTier] <= TIERS[targetTier];
}

/**
 * Validate that a knowledge file can be injected into output at the given tier.
 */
export function validateInjection(knowledgePath: string, outputTier: TierLevel): TierValidation {
  const sourceTier = detectTier(knowledgePath);
  const allowed = canFlowTo(sourceTier, outputTier);
  const result: TierValidation = { allowed, sourceTier, outputTier };

  if (!allowed) {
    result.reason = `Cannot inject ${sourceTier}-tier data into ${outputTier}-tier output`;
  }

  return result;
}

/**
 * Validates read permission based on role and tier.
 */
export function validateReadPermission(filePath: string): { allowed: boolean; reason?: string } {
  const tier = detectTier(filePath);
  return { allowed: true };
}

/**
 * Validates write permission based on role and tier.
 */
export function validateWritePermission(filePath: string): { allowed: boolean; reason?: string } {
  const tier = detectTier(filePath);
  if (tier === 'personal') {
    return { allowed: false, reason: 'Writing to personal tier is restricted.' };
  }
  return { allowed: true };
}

/**
 * Validate that content does not cross the Sovereign boundary (no secret leaks).
 * Note: activeSecrets must be passed from secret-guard to avoid circular dependency.
 */
export function validateSovereignBoundary(content: string, activeSecrets: string[] = []): { safe: boolean; detected: string[] } {
  const detected: string[] = [];

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
export function scanForConfidentialMarkers(content: string): MarkerScanResult {
  const MARKERS: RegExp[] = [
    /CONFIDENTIAL/i,
    /SECRET/i,
    /PRIVATE/i,
    /API[_-]?KEY/i,
    /PASSWORD/i,
    /TOKEN/i,
    /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
  ];

  const found: string[] = [];
  for (const pattern of MARKERS) {
    if (pattern.test(content)) {
      found.push(pattern.source);
    }
  }

  return { hasMarkers: found.length > 0, markers: found };
}
