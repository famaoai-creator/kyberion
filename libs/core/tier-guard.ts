/**
 * TypeScript version of the Knowledge Tier Guard.
 * v2.2 - POLICY-AS-CODE (ADF DRIVEN) with Persona Integration
 */

import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { rawExistsSync, rawReadTextFile } from './fs-primitives.js';
import { resolveIdentityContext } from './authority.js';
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

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '');
}

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
 * Validates write permission based on security-policy.json ADF and Persona.
 */
export function validateWritePermission(filePath: string): { allowed: boolean; reason?: string } {
  const resolvedPath = path.resolve(filePath);
  const relativePath = path.relative(PROJECT_ROOT, resolvedPath);
  const currentMission = process.env.MISSION_ID;

  if (isOutsideProjectRoot(relativePath)) {
    return { allowed: false, reason: `[POLICY_VIOLATION] Path outside project root: '${resolvedPath}'` };
  }

  // 1. Identify Identity Context (Persona & Authority)
  const { persona: currentPersona } = resolveIdentityContext();

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

  // B. Persona-based Allow (authoritative — overrides tier restrictions)
  const roleRules = policy.role_permissions[currentPersona];
  if (roleRules?.allow_write?.some((p: string) => pathStartsWith(relativePath, p))) return { allowed: true };

  // C. Architect Privilege (broad knowledge access)
  if (currentPersona === 'ecosystem_architect' && pathStartsWith(relativePath, 'knowledge')) return { allowed: true };

  // D. Tier-based Restrictions (fallback deny)
  if (pathStartsWith(relativePath, 'knowledge/personal')) {
    return { allowed: false, reason: policy.tier_restrictions.personal.block_message };
  }
  if (pathStartsWith(relativePath, 'knowledge/confidential')) {
    return { allowed: false, reason: policy.tier_restrictions.confidential.block_message };
  }

  // E. Default Deny
  return {
    allowed: false,
    reason: `[POLICY_VIOLATION] Persona '${currentPersona}' is NOT authorized to write to '${relativePath}'.`
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
 * Validates read permission based on security-policy.json ADF and Persona.
 */
export function validateReadPermission(filePath: string): { allowed: boolean; reason?: string } {
  const resolvedPath = path.resolve(filePath);
  const relativePath = path.relative(PROJECT_ROOT, resolvedPath);

  if (isOutsideProjectRoot(relativePath)) {
    return { allowed: false, reason: `[POLICY_VIOLATION] Path outside project root: '${resolvedPath}'` };
  }

  if (!pathStartsWith(relativePath, 'knowledge')) return { allowed: true };
  if (pathStartsWith(relativePath, 'knowledge/public')) return { allowed: true };

  if (!pathStartsWith(relativePath, 'knowledge/personal') &&
      !pathStartsWith(relativePath, 'knowledge/confidential')) {
    return { allowed: true };
  }

  let policy: any = null;
  try {
    if (rawExistsSync(POLICY_PATH)) {
      policy = JSON.parse(rawReadTextFile(POLICY_PATH));
    }
  } catch (_) {}

  if (!policy) return { allowed: true };

  const { persona: currentPersona } = resolveIdentityContext();

  const roleRules = policy.role_permissions[currentPersona];
  if (roleRules?.allow_read?.some((p: string) => pathStartsWith(relativePath, p))) return { allowed: true };
  if (roleRules?.allow_write?.some((p: string) => pathStartsWith(relativePath, p))) return { allowed: true };

  if (['ecosystem_architect', 'sovereign', 'sovereign_concierge', 'mission_controller'].includes(currentPersona)) {
    return { allowed: true };
  }

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
    } catch (_) {}
  }
  return { hasMarkers: markers.length > 0, markers };
}

function loadMarkerPatterns(): { name: string; regex: string }[] {
  const patterns: { name: string; regex: string }[] = [];
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
  return patterns;
}
