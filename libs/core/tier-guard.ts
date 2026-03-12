/**
 * TypeScript version of the Knowledge Tier Guard.
 * v2.1 - POLICY-AS-CODE (ADF DRIVEN)
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { pathResolver } from './path-resolver.js';
import type { TierLevel, TierWeightMap, TierValidation, MarkerScanResult } from './types.js';

export { TierLevel, TierWeightMap, TierValidation, MarkerScanResult };

/** Numeric weight for each tier (higher = more sensitive). */
export const TIERS: TierWeightMap = {
  personal: 4,
  confidential: 3,
  public: 1,
};

const PROJECT_ROOT = pathResolver.rootDir();
const POLICY_PATH = pathResolver.knowledge('public/governance/security-policy.json');

/**
 * Validates write permission based on security-policy.json ADF.
 */
export function validateWritePermission(filePath: string): { allowed: boolean; reason?: string } {
  const resolvedPath = path.resolve(filePath);
  const relativePath = path.relative(PROJECT_ROOT, resolvedPath);
  const currentMission = process.env.MISSION_ID;
  
  // 1. Identify Role
  let currentRole = (process.env.MISSION_ROLE || '').toLowerCase().replace(/\s+/g, '_');
  
  // A. Infer from active mission state
  if ((!currentRole || currentRole === 'unknown') && currentMission) {
    const statePath = pathResolver.active(`missions/${currentMission}/mission-state.json`);
    try {
      if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        currentRole = (state.assigned_persona || 'unknown').toLowerCase().replace(/\s+/g, '_');
      }
    } catch (_) {}
  }

  // B. Fallback to process name (crucial for controller/scripts)
  if (!currentRole || currentRole === 'unknown') {
    const procName = path.basename(process.argv[1], path.extname(process.argv[1]));
    currentRole = procName.toLowerCase().replace(/[-]/g, '_');
  }

  // 2. Load Policy
  let policy: any = null;
  try {
    if (fs.existsSync(POLICY_PATH)) {
      policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
    }
  } catch (_) {}

  if (!policy) return { allowed: true }; 

  // 2. Evaluate
  
  // A. Default Allow
  const defaultAllow = policy.default_allow.map((p: string) => 
    p.replace('${MISSION_ID}', currentMission || 'NONE')
  );
  if (defaultAllow.some((p: string) => relativePath.startsWith(p))) return { allowed: true };

  // B. Role-based Allow
  const roleRules = policy.role_permissions[currentRole];
  if (roleRules?.allow_write?.some((p: string) => relativePath.startsWith(p))) return { allowed: true };

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
  if (currentRole === 'ecosystem_architect' && relativePath.startsWith('knowledge/')) return { allowed: true };

  return { 
    allowed: false, 
    reason: `[POLICY_VIOLATION] Role '${currentRole}' is NOT authorized to write to '${relativePath}'.` 
  };
}

/**
 * Determine the knowledge tier of a file based on its path.
 */
export function detectTier(filePath: string): TierLevel {
  const resolved = path.resolve(filePath);
  if (resolved.includes('/knowledge/personal/')) return 'personal';
  if (resolved.includes('/knowledge/confidential/')) return 'confidential';
  return 'public';
}

/**
 * Legacy Support
 */
export function detectTenant(filePath: string): string | null {
  const resolved = path.resolve(filePath);
  const vaultRoot = path.resolve(PROJECT_ROOT, 'vault');
  if (resolved.startsWith(vaultRoot)) {
    const relative = path.relative(vaultRoot, resolved);
    return relative.split(path.sep)[0] || null;
  }
  return null;
}

export function validateReadPermission(filePath: string): { allowed: boolean; reason?: string } {
  return { allowed: true };
}

export function validateSovereignBoundary(content: string, activeSecrets: string[] = []): { safe: boolean; detected: string[] } {
  return { safe: true, detected: [] };
}

export function scanForConfidentialMarkers(content: string): MarkerScanResult {
  return { hasMarkers: false, markers: [] };
}
