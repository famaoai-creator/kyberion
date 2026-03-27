/**
 * TypeScript version of the Knowledge Tier Guard.
 * v2.2 - POLICY-AS-CODE (ADF DRIVEN) with Persona Integration
 */

import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { rawExistsSync, rawReadTextFile } from './fs-primitives.js';
import { resolveIdentityContext } from './authority.js';
import type { TierLevel, TierWeightMap, TierValidation, MarkerScanResult, Authority, TierScope } from './types.js';

export { TierLevel, TierScope, TierWeightMap, TierValidation, MarkerScanResult };

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

function loadPolicy(): any | null {
  try {
    if (rawExistsSync(POLICY_PATH)) {
      return JSON.parse(rawReadTextFile(POLICY_PATH));
    }
  } catch (_) {}
  return null;
}

/**
 * Checks project-level access within the confidential tier.
 * Returns null if no project scope restriction applies (pass-through),
 * or a rejection result if access is denied.
 */
function checkProjectScope(
  relativePath: string,
  policy: any,
  currentPersona: string,
  authorities: Authority[],
): { allowed: false; reason: string } | null {
  if (!pathStartsWith(relativePath, 'knowledge/confidential/')) return null;

  const projectMatch = relativePath.match(/^knowledge\/confidential\/([^/]+)\//);
  if (!projectMatch) return null;

  const project = projectMatch[1];
  if (project === '_default') return null;

  const projectPerms = policy.project_permissions?.[project];
  if (!projectPerms) return null; // No project-specific rules; fall through to default tier check

  const allowed =
    projectPerms.allowed_personas?.includes(currentPersona) ||
    projectPerms.allowed_roles?.some((r: string) => authorities.includes(r as Authority));
  if (!allowed) {
    return {
      allowed: false,
      reason: `[POLICY_VIOLATION] Persona '${currentPersona}' is not authorized for project '${project}'.`,
    };
  }
  return null;
}

function expandMissionPath(pattern: string, missionId?: string): string {
  return pattern.replace('${MISSION_ID}', missionId || 'NONE');
}

function matchesAny(relativePath: string, patterns: string[] = [], missionId?: string): boolean {
  return patterns.some((p) => pathStartsWith(relativePath, expandMissionPath(p, missionId)));
}

function hasScopedSudoAccess(relativePath: string, sudoScope?: string[]): boolean {
  if (!sudoScope || sudoScope.length === 0) return true;
  return sudoScope.some((scope) => pathStartsWith(relativePath, scope));
}

function hasAuthorityAccess(
  policy: any,
  authorities: Authority[],
  relativePath: string,
  missionId?: string,
  accessType: 'allow_read' | 'allow_write' = 'allow_write',
): boolean {
  const authorityPermissions = policy.authority_permissions || {};
  return authorities.some((authority) => matchesAny(relativePath, authorityPermissions[authority]?.[accessType], missionId));
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
  const { persona: currentPersona, role: currentRole, authorities, sudoScope } = resolveIdentityContext();
  const policy = loadPolicy();
  if (!policy) return { allowed: true };

  const defaultAllow = (policy.default_allow || []).map((p: string) => expandMissionPath(p, currentMission));
  if (defaultAllow.some((p: string) => pathStartsWith(relativePath, p))) return { allowed: true };

  if (authorities.includes('SUDO') && hasScopedSudoAccess(relativePath, sudoScope)) return { allowed: true };
  if (hasAuthorityAccess(policy, authorities, relativePath, currentMission, 'allow_write')) return { allowed: true };

  const roleRules = currentRole ? policy.authority_role_permissions?.[currentRole] : null;
  if (roleRules?.allow_write?.some((p: string) => pathStartsWith(relativePath, expandMissionPath(p, currentMission)))) {
    return { allowed: true };
  }

  const personaRules = policy.persona_permissions?.[currentPersona];
  if (personaRules?.allow_write?.some((p: string) => pathStartsWith(relativePath, expandMissionPath(p, currentMission)))) {
    return { allowed: true };
  }

  // Project scope check for confidential tier (before generic tier restrictions)
  const projectDenial = checkProjectScope(relativePath, policy, currentPersona, authorities);
  if (projectDenial) return projectDenial;

  if (pathStartsWith(relativePath, 'knowledge/personal')) {
    return { allowed: false, reason: policy.tier_restrictions.personal.block_message };
  }
  if (pathStartsWith(relativePath, 'knowledge/confidential')) {
    return { allowed: false, reason: policy.tier_restrictions.confidential.block_message };
  }
  return {
    allowed: false,
    reason: `[POLICY_VIOLATION] Persona '${currentPersona}' with authority role '${currentRole || 'unknown'}' is NOT authorized to write to '${relativePath}'.`
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

  const policy = loadPolicy();
  if (!policy) return { allowed: true };

  const { persona: currentPersona, role: currentRole, authorities, sudoScope } = resolveIdentityContext();

  if (authorities.includes('SUDO') && hasScopedSudoAccess(relativePath, sudoScope)) return { allowed: true };
  if (hasAuthorityAccess(policy, authorities, relativePath, process.env.MISSION_ID, 'allow_read')) return { allowed: true };
  if (hasAuthorityAccess(policy, authorities, relativePath, process.env.MISSION_ID, 'allow_write')) return { allowed: true };

  const roleRules = currentRole ? policy.authority_role_permissions?.[currentRole] : null;
  if (roleRules?.allow_read?.some((p: string) => pathStartsWith(relativePath, expandMissionPath(p, process.env.MISSION_ID)))) return { allowed: true };
  if (roleRules?.allow_write?.some((p: string) => pathStartsWith(relativePath, expandMissionPath(p, process.env.MISSION_ID)))) return { allowed: true };

  const personaRules = policy.persona_permissions?.[currentPersona];
  if (personaRules?.allow_read?.some((p: string) => pathStartsWith(relativePath, expandMissionPath(p, process.env.MISSION_ID)))) return { allowed: true };
  if (personaRules?.allow_write?.some((p: string) => pathStartsWith(relativePath, expandMissionPath(p, process.env.MISSION_ID)))) return { allowed: true };

  // Project scope check for confidential tier (before generic tier restrictions)
  const projectDenial = checkProjectScope(relativePath, policy, currentPersona, authorities);
  if (projectDenial) return projectDenial;

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
