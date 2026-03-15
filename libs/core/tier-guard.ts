/**
 * TypeScript version of the Knowledge Tier Guard.
 * v2.1 - POLICY-AS-CODE (ADF DRIVEN)
 */

import * as path from 'node:path';
import { pathResolver } from './path-resolver';
import { rawExistsSync, rawReadTextFile } from './fs-primitives';
import type { TierLevel, TierWeightMap, TierValidation, MarkerScanResult } from './types';

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

function isOutsideProjectRoot(relativePath: string): boolean {
  if (!relativePath) return false;
  const firstSegment = relativePath.split(path.sep)[0];
  return firstSegment === '..';
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

  if (isOutsideProjectRoot(relativePath)) {
    return { allowed: false, reason: `[POLICY_VIOLATION] Path outside project root: '${resolvedPath}'` };
  }

  // 1. Identify Role
  const currentRole = resolveCurrentRole();

  // 2. Load Policy
  let policy: any = null;
  try {
    if (rawExistsSync(POLICY_PATH)) {
      policy = JSON.parse(rawReadTextFile(POLICY_PATH));
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
      if (rawExistsSync(statePath)) {
        const state = JSON.parse(rawReadTextFile(statePath));
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

  if (isOutsideProjectRoot(relativePath)) {
    return { allowed: false, reason: `[POLICY_VIOLATION] Path outside project root: '${resolvedPath}'` };
  }

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
    if (rawExistsSync(POLICY_PATH)) {
      policy = JSON.parse(rawReadTextFile(POLICY_PATH));
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
  if (!content || activeSecrets.length === 0) return { safe: true, detected: [] };
  const detected: string[] = [];
  for (const secret of activeSecrets) {
    if (secret && content.includes(secret)) {
      const masked = secret.length <= 8 ? '********' : `${secret.slice(0, 4)}...${secret.slice(-4)}`;
      detected.push(`SECRET_LEAK:${masked}`);
    }
  }
  return { safe: detected.length === 0, detected };
}

export function scanForConfidentialMarkers(content: string): MarkerScanResult {
  if (!content) return { hasMarkers: false, markers: [] };

  const markers: string[] = [];
  const patterns = loadMarkerPatterns();

  for (const pattern of patterns) {
    try {
      const re = new RegExp(pattern.regex, 'm');
      if (re.test(content)) {
        markers.push(pattern.name);
      }
    } catch (_) {
      // Ignore invalid regex
    }
  }

  return { hasMarkers: markers.length > 0, markers };
}

type MarkerPattern = { name: string; regex: string };
let cachedMarkerPatterns: MarkerPattern[] | null = null;

function loadMarkerPatterns(): MarkerPattern[] {
  if (cachedMarkerPatterns) return cachedMarkerPatterns;

  const patterns: MarkerPattern[] = [];

  // Knowledge sync rules (PII/secret patterns)
  try {
    const policyPath = pathResolver.knowledge('public/governance/knowledge-sync-rules.json');
    if (rawExistsSync(policyPath)) {
      const rules = JSON.parse(rawReadTextFile(policyPath));
      const pii = rules?.security?.pii_patterns || [];
      for (const p of pii) {
        if (p?.name && p?.regex) patterns.push({ name: p.name, regex: p.regex });
      }
    }
  } catch (_) {}

  // Security scanner patterns (augment with critical items)
  try {
    const vulnPath = pathResolver.knowledge('public/skills/security-scanner/vulnerability-patterns.json');
    if (rawExistsSync(vulnPath)) {
      const vulns = JSON.parse(rawReadTextFile(vulnPath));
      if (Array.isArray(vulns)) {
        for (const v of vulns) {
          if (v?.name && v?.regex) patterns.push({ name: v.name, regex: v.regex });
        }
      }
    }
  } catch (_) {}

  cachedMarkerPatterns = patterns;
  return patterns;
}
