/**
 * TypeScript version of the Knowledge Tier Guard.
 * v2.0 - HARDENED ROLE-BASED ACCESS CONTROL (RBAC)
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { dynamicPermGuard } from './dynamic-permission-guard.js';
import type { TierLevel, TierWeightMap, TierValidation, MarkerScanResult } from './types.js';

export { TierLevel, TierWeightMap, TierValidation, MarkerScanResult };

/** Numeric weight for each tier (higher = more sensitive). */
export const TIERS: TierWeightMap = {
  personal: 4,
  confidential: 3,
  public: 1,
};

const ROOT_DIR = process.cwd();
const KNOWLEDGE_ROOT: string = path.join(ROOT_DIR, 'knowledge');
const ACCESS_MATRIX_PATH = path.join(KNOWLEDGE_ROOT, 'governance/role-write-access.json');

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
 * Validates write permission based on CURRENT ROLE and target path.
 * This is the CORE of the Hardened Role Guard.
 */
export function validateWritePermission(filePath: string): { allowed: boolean; reason?: string } {
  const resolvedPath = path.resolve(filePath);
  const currentMission = process.env.MISSION_ID;
  
  // 1. Identify Current Role from physical state or environment
  let currentRole = 'unknown';
  const envRole = process.env.MISSION_ROLE;

  if (currentMission) {
    const statePath = path.join(ROOT_DIR, 'active/missions', currentMission, 'mission-state.json');
    try {
      if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        currentRole = (state.assigned_persona || 'unknown').toLowerCase().replace(/\s+/g, '_');
      }
    } catch (_) {}
  }

  // Fallback to environment role if unknown (crucial for mission bootstrap)
  if (currentRole === 'unknown' && envRole) {
    currentRole = envRole.toLowerCase().replace(/\s+/g, '_');
  }

  // 2. Load Role-Based Access Matrix
  let matrix: any = null;
  try {
    if (fs.existsSync(ACCESS_MATRIX_PATH)) {
      matrix = JSON.parse(fs.readFileSync(ACCESS_MATRIX_PATH, 'utf8'));
    }
  } catch (_) {}

  if (!matrix) return { allowed: true }; // Fallback to permissive if matrix missing (to avoid bootstrap deadlock)

  // 3. Evaluate Permissions
  const relativePath = path.relative(ROOT_DIR, resolvedPath);
  
  // A. Check Default Allowed (Mission Dir, Scratch, etc.)
  const defaultAllow = matrix.default_allow.map((p: string) => 
    p.replace('${MISSION_ID}', currentMission || 'NONE')
  );
  if (defaultAllow.some((p: string) => relativePath.startsWith(p))) {
    return { allowed: true };
  }

  // B. Check Role Specific Allowed
  const roleConfig = matrix.roles[currentRole];
  if (roleConfig && roleConfig.allow) {
    if (roleConfig.allow.some((p: string) => relativePath.startsWith(p))) {
      return { allowed: true };
    }
  }

  // C. Special Privilege: Ecosystem Architect can write almost anywhere in Public Tier
  if (currentRole === 'ecosystem_architect' && relativePath.startsWith('knowledge/')) {
    return { allowed: true };
  }

  return { 
    allowed: false, 
    reason: `[ROLE_VIOLATION] Role '${currentRole}' is NOT authorized to write to '${relativePath}'.` 
  };
}

/**
 * Existing Legacy Guard Functions (Restored for compatibility)
 */
export function detectTenant(filePath: string): string | null {
  const resolved = path.resolve(filePath);
  const vaultRoot = path.resolve(ROOT_DIR, 'vault');
  if (resolved.startsWith(vaultRoot)) {
    const relative = path.relative(vaultRoot, resolved);
    return relative.split(path.sep)[0] || null;
  }
  return null;
}

export function validateReadPermission(filePath: string): { allowed: boolean; reason?: string } {
  const tenant = detectTenant(filePath);
  const activeTenant = process.env.ACTIVE_TENANT;
  if (tenant && activeTenant && tenant !== activeTenant) {
    return { allowed: false, reason: `[TENANT_VIOLATION] Read access denied for tenant '${tenant}'.` };
  }
  return { allowed: true };
}

export function validateSovereignBoundary(content: string, activeSecrets: string[] = []): { safe: boolean; detected: string[] } {
  const detected: string[] = [];
  for (const secret of activeSecrets) {
    if (content.includes(secret)) detected.push(`SECRET_LEAK: ${secret.substring(0, 3)}...`);
  }
  const markerCheck = scanForConfidentialMarkers(content);
  if (markerCheck.hasMarkers) detected.push(...markerCheck.markers.map(m => `MARKER_DETECTED: ${m}`));
  return { safe: detected.length === 0, detected };
}

export function scanForConfidentialMarkers(content: string): MarkerScanResult {
  const MARKERS: RegExp[] = [/CONFIDENTIAL/i, /SECRET/i, /PRIVATE/i, /API[_-]?KEY/i, /PASSWORD/i, /TOKEN/i, /Bearer\s+[A-Za-z0-9\-._~+/]+=*/];
  const found: string[] = [];
  for (const pattern of MARKERS) { if (pattern.test(content)) found.push(pattern.source); }
  return { hasMarkers: found.length > 0, markers: found };
}
