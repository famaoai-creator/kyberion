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
 * Normalize a path pattern for consistent comparison.
 * Strips trailing slashes so "knowledge/personal/missions/" and
 * "knowledge/personal/missions" match equivalently via pathStartsWith.
 */
function normalizePath(p: string): string {
  return p.replace(/\/+$/, '');
}

/**
 * Check if targetPath starts with or equals the patternPath.
 * Both sides are normalized to avoid trailing-slash mismatches.
 * Ensures "knowledge/personal" does NOT match "knowledge/personal-other/".
 */
function pathStartsWith(targetPath: string, patternPath: string): boolean {
  const t = normalizePath(targetPath);
  const p = normalizePath(patternPath);
  return t === p || t.startsWith(p + '/');
}

/**
 * Validates write permission based on security-policy.json ADF.
 *
 * Evaluation order (Explicit Allow > Implicit Deny):
 *   1. Default Allow — sandbox paths always writable
 *   2. Role-based Allow (authoritative) — explicit grants override tier restrictions
 *   3. Tier-based Deny (fallback) — applies only when no explicit grant matched
 *   4. Architect Privilege — ecosystem_architect has broad knowledge access
 *   5. Default Deny
 */
export function validateWritePermission(filePath: string): { allowed: boolean; reason?: string } {
  const resolvedPath = path.resolve(filePath);
  const relativePath = path.relative(PROJECT_ROOT, resolvedPath);
  const currentMission = process.env.MISSION_ID;

  // 1. Identify Role
  const currentRole = resolveCurrentRole();

  // 2. Load Policy
  let policy: any = null;
  try {
    if (fs.existsSync(POLICY_PATH)) {
      policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
    }
  } catch (_) {}

  if (!policy) return { allowed: true };

  // 3. Evaluate (Explicit Allow > Implicit Deny)

  // A. Default Allow — sandbox paths
  const defaultAllow = policy.default_allow.map((p: string) =>
    p.replace('${MISSION_ID}', currentMission || 'NONE')
  );
  if (defaultAllow.some((p: string) => pathStartsWith(relativePath, p))) return { allowed: true };

  // B. Role-based Allow (authoritative — overrides tier restrictions)
  const roleRules = policy.role_permissions[currentRole];
  if (roleRules?.allow_write?.some((p: string) => pathStartsWith(relativePath, p))) return { allowed: true };

  // C. Architect Privilege (broad knowledge access)
  if (currentRole === 'ecosystem_architect' && pathStartsWith(relativePath, 'knowledge')) return { allowed: true };

  // D. Tier-based Restrictions (fallback deny — only reached if no explicit grant matched)
  if (pathStartsWith(relativePath, 'knowledge/personal')) {
    return { allowed: false, reason: policy.tier_restrictions.personal.block_message };
  }
  if (pathStartsWith(relativePath, 'knowledge/confidential')) {
    return { allowed: false, reason: policy.tier_restrictions.confidential.block_message };
  }

  // E. Default Deny
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

/**
 * Resolves the current role using the same strategy as validateWritePermission.
 */
function resolveCurrentRole(): string {
  let currentRole = (process.env.MISSION_ROLE || '').toLowerCase().replace(/\s+/g, '_');

  if ((!currentRole || currentRole === 'unknown') && process.env.MISSION_ID) {
    const statePath = pathResolver.active(`missions/${process.env.MISSION_ID}/mission-state.json`);
    try {
      if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        currentRole = (state.assigned_persona || 'unknown').toLowerCase().replace(/\s+/g, '_');
      }
    } catch (_) {}
  }

  if (!currentRole || currentRole === 'unknown') {
    const argv1 = process.argv[1] || '';
    const procName = argv1 ? path.basename(argv1, path.extname(argv1)) : 'unknown';
    currentRole = procName.toLowerCase().replace(/[-]/g, '_');
  }

  return currentRole;
}

/**
 * Validates read permission based on security-policy.json ADF.
 *
 * Evaluation order (mirrors write permission logic):
 *   1. Public tier — always readable
 *   2. Role-based Allow — explicit allow_read grants
 *   3. Architect / Concierge Privilege — broad knowledge read access
 *   4. Tier-based Deny — Personal and Confidential restrictions
 */
export function validateReadPermission(filePath: string): { allowed: boolean; reason?: string } {
  const resolvedPath = path.resolve(filePath);
  const relativePath = path.relative(PROJECT_ROOT, resolvedPath);

  // Fast path: non-knowledge files are always readable
  if (!pathStartsWith(relativePath, 'knowledge')) return { allowed: true };

  // Public knowledge is always readable
  if (pathStartsWith(relativePath, 'knowledge/public')) return { allowed: true };

  // Non-sensitive tiers don't need restriction
  if (!pathStartsWith(relativePath, 'knowledge/personal') &&
      !pathStartsWith(relativePath, 'knowledge/confidential')) {
    return { allowed: true };
  }

  // Load policy
  let policy: any = null;
  try {
    if (fs.existsSync(POLICY_PATH)) {
      policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
    }
  } catch (_) {}

  if (!policy) return { allowed: true };

  const currentRole = resolveCurrentRole();

  // Role-based Allow (authoritative)
  const roleRules = policy.role_permissions[currentRole];
  if (roleRules?.allow_read?.some((p: string) => pathStartsWith(relativePath, p))) return { allowed: true };
  // Write access implies read access
  if (roleRules?.allow_write?.some((p: string) => pathStartsWith(relativePath, p))) return { allowed: true };

  // Architect and Concierge have broad read access
  if (['ecosystem_architect', 'sovereign_concierge', 'mission_controller'].includes(currentRole)) {
    return { allowed: true };
  }

  // Tier-based deny
  if (pathStartsWith(relativePath, 'knowledge/personal')) {
    return { allowed: false, reason: policy.tier_restrictions.personal.block_message };
  }
  if (pathStartsWith(relativePath, 'knowledge/confidential')) {
    return { allowed: false, reason: policy.tier_restrictions.confidential.block_message };
  }

  return { allowed: true };
}

export function validateSovereignBoundary(content: string, activeSecrets: string[] = []): { safe: boolean; detected: string[] } {
  return { safe: true, detected: [] };
}

export function scanForConfidentialMarkers(content: string): MarkerScanResult {
  return { hasMarkers: false, markers: [] };
}
