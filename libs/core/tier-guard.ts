/**
 * TypeScript version of the Knowledge Tier Guard.
 * v2.2 - POLICY-AS-CODE (ADF DRIVEN) with Persona Integration
 */

import * as path from 'node:path';
import { getRegisteredEnvBool, getRegisteredEnvText } from './foundation/env.js';
import { parseSafeJsonObjectInput, parseSafeJsonInput } from './foundation/safe-json.js';
import { isRecord } from './foundation/text.js';
import { pathResolver } from './path-resolver.js';
import { rawExistsSync, rawReadTextFile } from './fs-primitives.js';
import { resolveProjectScope, resolveProjectScopeId } from './foundation/project-scope-env.js';
import { resolvePolicyIdentityContext } from './identity-context-bridge.js';
import { createLogger, emitConsoleLine } from './logger.js';
import type { AuditEntry } from './governance/audit-chain.js';
import { isValidTenantSlug } from './entity-scope.js';
import {
  STORAGE_FLOOR_ROOTS,
  classifyStorageFloorPath,
  storageFloorTier,
  storageFloorTierInPath,
} from './storage-layout.js';
import { assertSandboxWriteAllowed } from './shell/sandbox-policy.js';
import { isAllowedVaultMountPath } from './secret/vault-mount.js';
import { currentExecutionScope } from './foundation/execution-scope.js';
import type {
  TierLevel,
  TierWeightMap,
  TierValidation,
  MarkerScanResult,
  Authority,
  TierScope,
} from './types.js';

export { TierLevel, TierScope, TierWeightMap, TierValidation, MarkerScanResult };

/** Numeric weight for each tier (higher = more sensitive). */
export const TIERS: TierWeightMap = {
  personal: 4,
  confidential: 3,
  public: 1,
};

const POLICY_PATH = pathResolver.knowledge('product/governance/security-policy.json');

// Resolve lazily because foundation/env -> foundation/json -> secure-io imports
// tier-guard during module bootstrap. A top-level root lookup is otherwise
// observable before this module's lexical bindings have finished initializing.
function projectRoot(): string {
  try {
    return pathResolver.rootDir();
  } catch {
    // The secure-io -> audit-chain -> tier-guard bootstrap cycle can invoke
    // the guard before the path-resolver binding is initialized. The process
    // root is the safe fallback for that one-time project-local probe.
    return process.cwd();
  }
}

function trimTrailingSlashes(value: string): string {
  // A linear scan instead of `/\/+$/`, which backtracks quadratically on long
  // runs of '/' (CodeQL js/polynomial-redos).
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function normalizePath(p: string): string {
  // Policy paths use POSIX separators even when Kyberion runs on Windows.
  // `path.relative()` returns `\\` on Windows, so normalize both forms before
  // matching policy prefixes.
  return trimTrailingSlashes(p.replace(/\\/g, '/'));
}

function pathStartsWith(targetPath: string, patternPath: string): boolean {
  const t = normalizePath(targetPath);
  const p = normalizePath(patternPath);
  return t === p || t.startsWith(p + '/');
}

function isOutsideProjectRoot(relativePath: string): boolean {
  if (!relativePath) return false;
  const firstSegment = normalizePath(relativePath).split('/')[0];
  return firstSegment === '..';
}

const logger = createLogger('tier-guard');

type PolicyLoad = { status: 'loaded'; policy: any } | { status: 'missing' } | { status: 'corrupt' };

let corruptPolicyWarned = false;

/**
 * A missing policy means an unprovisioned workspace (allow: bootstrap).
 * A policy that exists but cannot be parsed must NOT silently disable tier
 * isolation — protected tiers fail closed until the file is repaired.
 */
function loadPolicy(): PolicyLoad {
  if (!rawExistsSync(POLICY_PATH)) return { status: 'missing' };
  try {
    const policy = parseSafeJsonObjectInput(rawReadTextFile(POLICY_PATH), 'security policy');
    if (!policy) throw new Error('security policy must not be empty');
    return { status: 'loaded', policy };
  } catch (err) {
    if (!corruptPolicyWarned) {
      corruptPolicyWarned = true;
      logger.error(
        `security-policy.json exists but cannot be parsed; personal/confidential tiers fail closed: ${err}`
      );
    }
    return { status: 'corrupt' };
  }
}

function isProtectedTierPath(relativePath: string): boolean {
  return (
    pathStartsWith(relativePath, 'knowledge/personal') ||
    pathStartsWith(relativePath, 'knowledge/confidential') ||
    pathStartsWith(relativePath, 'active/organizations/personal') ||
    pathStartsWith(relativePath, 'active/organizations/confidential') ||
    pathStartsWith(relativePath, 'active/projects/personal') ||
    pathStartsWith(relativePath, 'active/missions/confidential') ||
    pathStartsWith(relativePath, 'active/projects/confidential') ||
    isProtectedStorageFloorTier(storageFloorTier(relativePath))
  );
}

/** `<floor>/<tier>/` prefix when the path is in a personal/confidential floor partition. */
function protectedFloorPartitionPrefix(relativePath: string): string | undefined {
  const floor = classifyStorageFloorPath(relativePath);
  if (floor?.partition.kind !== 'tier') return undefined;
  const { tier } = floor.partition;
  if (!isProtectedStorageFloorTier(tier)) return undefined;
  return `${STORAGE_FLOOR_ROOTS[floor.floor]}/${tier}/`;
}

/** Personal/confidential partitions of the shared storage floors (storage-layout.ts). */
function isProtectedStorageFloorTier(tier: TierLevel | undefined): boolean {
  return tier === 'personal' || tier === 'confidential';
}

const CORRUPT_POLICY_DENIAL = {
  allowed: false as const,
  reason:
    '[POLICY_VIOLATION] security-policy.json exists but cannot be parsed. Access to personal/confidential tiers fails closed until the policy file is repaired.',
};

/**
 * Checks project-level access within the confidential tier.
 * Returns null if no project scope restriction applies (pass-through),
 * or a rejection result if access is denied.
 */
function checkProjectScope(
  relativePath: string,
  policy: any,
  currentPersona: string,
  authorities: Authority[]
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

const TENANT_PLACEHOLDER = '${KYBERION_TENANT}';
const PROJECT_ID_PLACEHOLDER = '${KYBERION_PROJECT_ID}';
const ORGANIZATION_ID_PLACEHOLDER = '${KYBERION_ORGANIZATION_ID}';

/**
 * Expand policy placeholders. `${KYBERION_TENANT}` expands to the tenant bound
 * by the resolved identity (env, execution scope, or mission state). It is what
 * lets a role such as `organization_operator` be granted "its own tenant only":
 * when no valid tenant is bound (missing, reserved such as `shared`/`public`,
 * or malformed) the pattern returns null and must never match, so an unbound
 * process gets no tenant-parameterised grant at all rather than a wildcard.
 * `${KYBERION_ORGANIZATION_ID}` is narrower still: it is expanded only from
 * an explicit organization bound to the current execution scope.
 */
function expandPolicyPath(pattern: string, missionId?: string, tenantSlug?: string): string | null {
  if (pattern.includes(ORGANIZATION_ID_PLACEHOLDER)) {
    const organizationId = currentExecutionScope()?.organizationId?.trim() || '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(organizationId)) return null;
    pattern = pattern.split(ORGANIZATION_ID_PLACEHOLDER).join(organizationId);
  }
  if (pattern.includes(TENANT_PLACEHOLDER)) {
    const tenant = tenantSlug?.trim() || '';
    if (!tenant || !isValidTenantSlug(tenant)) return null;
    pattern = pattern.split(TENANT_PLACEHOLDER).join(tenant);
  }
  if (pattern.includes(PROJECT_ID_PLACEHOLDER)) {
    const projectId = resolveProjectScopeId() || '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(projectId)) return null;
    pattern = pattern.split(PROJECT_ID_PLACEHOLDER).join(projectId);
  }
  const customerSlug = getRegisteredEnvText('KYBERION_CUSTOMER')?.trim() || 'NONE';
  return pattern
    .replace('${MISSION_ID}', missionId || 'NONE')
    .replace('${KYBERION_CUSTOMER}', customerSlug);
}

function policyPathMatches(
  relativePath: string,
  pattern: string,
  missionId?: string,
  tenantSlug?: string
): boolean {
  const expanded = expandPolicyPath(pattern, missionId, tenantSlug);
  return expanded !== null && pathStartsWith(relativePath, expanded);
}

/**
 * Read-grant match for a personal/confidential storage-floor partition. A grant
 * on the floor root or an `active/shared` ancestor (e.g. `active/shared/tmp/`)
 * predates the partitions and keeps covering legacy/system/public data only;
 * reading a protected partition needs a grant naming `<floor>/<tier>/` or
 * deeper (or a deliberately broad `active/`-level grant).
 */
function readGrantMatches(
  relativePath: string,
  pattern: string,
  missionId: string | undefined,
  tenantSlug: string | undefined,
  partitionPrefix: string | undefined
): boolean {
  if (!policyPathMatches(relativePath, pattern, missionId, tenantSlug)) return false;
  if (!partitionPrefix) return true;
  const expanded = normalizePath(expandPolicyPath(pattern, missionId, tenantSlug) ?? '').replace(
    /\/+$/u,
    ''
  );
  const isSharedAncestor =
    pathStartsWith(expanded, 'active/shared') &&
    pathStartsWith(partitionPrefix, expanded) &&
    expanded.length < partitionPrefix.replace(/\/+$/u, '').length;
  return !isSharedAncestor;
}

function matchesAny(
  relativePath: string,
  patterns: string[] = [],
  missionId?: string,
  partitionPrefix?: string
): boolean {
  return patterns.some((p) =>
    readGrantMatches(relativePath, p, missionId, undefined, partitionPrefix)
  );
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
  partitionPrefix?: string
): boolean {
  const authorityPermissions = policy.authority_permissions || {};
  return authorities.some((authority) =>
    matchesAny(
      relativePath,
      authorityPermissions[authority]?.[accessType],
      missionId,
      partitionPrefix
    )
  );
}

function tenantScopeConfig(policy: any): {
  protectedPrefixes: string[];
  sharedPrefixes: string[];
  systemRegistryReads: Array<{ path: string; roles: string[] }>;
  requireTenantBinding: boolean;
  slugPattern: RegExp;
  brokerRequirements: {
    requireApprovedBy: boolean;
    requireApprovedAt: boolean;
    requireExpiresAt: boolean;
  };
} {
  const cfg = policy?.tenant_scope || {};
  const slugPatternRaw =
    typeof cfg.slug_pattern === 'string' ? cfg.slug_pattern : '^[a-z][a-z0-9-]{1,30}$';
  let slugPattern = /^[a-z][a-z0-9-]{1,30}$/;
  try {
    slugPattern = new RegExp(slugPatternRaw);
  } catch (_) {
    /* fallback */
  }
  return {
    protectedPrefixes: Array.isArray(cfg.protected_prefixes)
      ? cfg.protected_prefixes
      : ['knowledge/confidential/'],
    sharedPrefixes: Array.isArray(cfg.shared_prefixes)
      ? cfg.shared_prefixes
      : ['knowledge/confidential/heuristics/', 'knowledge/confidential/relationships/'],
    systemRegistryReads: Array.isArray(cfg.system_registry_reads)
      ? cfg.system_registry_reads.filter(
          (entry: unknown): entry is { path: string; roles: string[] } =>
            Boolean(entry) &&
            typeof (entry as { path?: unknown }).path === 'string' &&
            Array.isArray((entry as { roles?: unknown }).roles) &&
            (entry as { roles: unknown[] }).roles.every((role) => typeof role === 'string')
        )
      : [
          {
            path: 'knowledge/confidential/tenants/index.json',
            roles: ['check_tenant_registry_consistency'],
          },
        ],
    // Tenant-qualified protected paths and shared groups require a
    // server-resolved binding. Unpartitioned legacy roots remain governed by
    // the existing tier/persona checks until their storage migration lands.
    requireTenantBinding:
      cfg.require_tenant_binding === true ||
      getRegisteredEnvBool('KYBERION_TENANT_SCOPE_REQUIRED') === true,
    slugPattern,
    brokerRequirements: {
      requireApprovedBy: cfg?.broker_requirements?.require_approved_by !== false,
      requireApprovedAt: cfg?.broker_requirements?.require_approved_at !== false,
      requireExpiresAt: cfg?.broker_requirements?.require_expires_at !== false,
    },
  };
}

function extractTenantFromProtectedPrefix(
  relativePath: string,
  protectedPrefixes: string[]
): { tenant: string; prefix: string } | null {
  for (const prefix of protectedPrefixes) {
    if (!pathStartsWith(relativePath, prefix)) continue;
    const rest = relativePath.slice(prefix.length);
    const tenant = rest.split(/[\\/]/)[0] || '';
    return { tenant, prefix };
  }
  return null;
}

function isRegisteredActiveTenant(tenantSlug: string): boolean {
  const profilePath = pathResolver.rootResolve(`knowledge/personal/tenants/${tenantSlug}.json`);
  if (!rawExistsSync(profilePath)) return false;
  try {
    const profile = normalizeRegisteredTenantProfile(
      parseSafeJsonInput(rawReadTextFile(profilePath), 'registered tenant profile')
    );
    if (!profile) return false;
    return profile.tenant_slug === tenantSlug && profile.status === 'active';
  } catch {
    return false;
  }
}

export function normalizeRegisteredTenantProfile(value: unknown): {
  tenant_slug: string;
  status: string;
} | null {
  if (!isRecord(value)) return null;
  if (typeof value.tenant_slug !== 'string' || typeof value.status !== 'string') return null;
  return { tenant_slug: value.tenant_slug, status: value.status };
}

interface TenantGroupProfile {
  tenant_group_id: string;
  status?: string;
  member_tenants?: string[];
  shared_prefixes?: string[];
}

function extractTenantGroupFromSharedPath(relativePath: string): string | null {
  const match = relativePath.match(
    /^knowledge\/confidential\/shared\/([a-z][a-z0-9-]{1,30})(?:\/|$)/
  );
  return match?.[1] ?? null;
}

function loadTenantGroupProfile(groupId: string): TenantGroupProfile | null {
  const file = pathResolver.knowledge(`confidential/tenant-groups/${groupId}.json`);
  try {
    if (!rawExistsSync(file)) return null;
    const profile = parseSafeJsonInput(rawReadTextFile(file), 'tenant group profile');
    if (!isValidTenantGroupProfile(groupId, profile)) return null;
    return profile;
  } catch (_) {
    return null;
  }
}

export function isValidTenantGroupProfile(
  groupId: string,
  profile: unknown
): profile is TenantGroupProfile {
  if (!isRecord(profile)) return false;
  const memberTenants = profile.member_tenants;
  const sharedPrefixes = profile.shared_prefixes;
  return (
    profile.tenant_group_id === groupId &&
    typeof profile.tenant_group_id === 'string' &&
    (profile.status === 'active' ||
      profile.status === 'suspended' ||
      profile.status === 'archived') &&
    Array.isArray(memberTenants) &&
    memberTenants.length > 0 &&
    memberTenants.every((tenant) => typeof tenant === 'string' && isValidTenantSlug(tenant)) &&
    Array.isArray(sharedPrefixes) &&
    sharedPrefixes.length > 0 &&
    sharedPrefixes.every(
      (prefix) =>
        typeof prefix === 'string' &&
        new RegExp(`^knowledge/confidential/shared/${groupId.replace(/[^\w-]/gu, '')}/`).test(
          prefix
        )
    )
  );
}

function checkTenantGroupScope(
  relativePath: string,
  tenantSlug: string | undefined,
  brokeredTenants: string[] | undefined
): { allowed: boolean; reason?: string } | null {
  const groupId = extractTenantGroupFromSharedPath(relativePath);
  if (!groupId) return null;

  const group = loadTenantGroupProfile(groupId);
  if (!group || group.status !== 'active') {
    return {
      allowed: false,
      reason: `[POLICY_VIOLATION] tenant.group_unknown — shared tenant group '${groupId}' is missing or inactive for '${relativePath}'.`,
    };
  }

  const members = Array.isArray(group.member_tenants) ? group.member_tenants : [];
  const sharedPrefixes =
    Array.isArray(group.shared_prefixes) && group.shared_prefixes.length > 0
      ? group.shared_prefixes
      : [`knowledge/confidential/shared/${groupId}/`];
  if (!sharedPrefixes.some((prefix) => pathStartsWith(relativePath, prefix))) {
    return {
      allowed: false,
      reason: `[POLICY_VIOLATION] tenant.group_prefix_violation — '${relativePath}' is not declared in tenant group '${groupId}'.`,
    };
  }

  if (!tenantSlug && !brokeredTenants) return null;
  if (tenantSlug && members.includes(tenantSlug)) {
    recordGroupAccess({ relativePath, groupId, tenantSlug });
    return null;
  }
  if (brokeredTenants?.some((tenant) => members.includes(tenant))) {
    recordGroupAccess({ relativePath, groupId, tenantSlug: tenantSlug ?? '(brokered)' });
    return null;
  }

  const actor = tenantSlug ? `tenant '${tenantSlug}'` : 'brokered tenant set';
  return {
    allowed: false,
    reason: `[POLICY_VIOLATION] tenant.group_scope_violation — ${actor} is not a member of shared tenant group '${groupId}' for '${relativePath}'.`,
  };
}

/**
 * Validates write permission based on security-policy.json ADF and Persona.
 */
/**
 * Tenant scope check — when the active identity is bound to a tenant,
 * deny writes to other tenants' confidential prefixes (`knowledge/confidential/{other}/`
 * or `active/missions/confidential/{other}/`). SUDO bypasses this check
 * because cross-tenant tooling missions intentionally need broad access.
 *
 * Brokered missions (declared by `cross_tenant_brokerage` in the mission
 * state) are allowed to access every tenant in their `source_tenants`
 * list — but no others. Each brokered access emits a
 * `tenant.broker_access` audit event so the cross-tenant action is
 * always reviewable.
 */
function checkTenantScope(
  policy: any,
  relativePath: string,
  tenantSlug: string | undefined,
  brokeredTenants: string[] | undefined,
  brokerApproval:
    | {
        purpose?: string;
        approvedBy?: string;
        approvedAt?: string;
        expiresAt?: string;
      }
    | undefined,
  authorities: Authority[],
  access: { kind: 'read' | 'write'; role?: string } = { kind: 'write' }
): { allowed: boolean; reason?: string } | null {
  if (authorities.includes('SUDO')) return null;
  const cfg = tenantScopeConfig(policy);
  // Cross-tenant registry files (e.g. the tenant design-override index under
  // knowledge/confidential/tenants/) are not a tenant's data, but they list
  // every tenant. Only the named system reader roles may READ them, whatever
  // the tenant binding, and every such read is audited. Writes and every
  // other role keep the normal tenant classification (denied when bound).
  if (access.kind === 'read' && access.role) {
    const role = access.role;
    const registry = cfg.systemRegistryReads.find(
      (entry) => pathStartsWith(relativePath, entry.path) && entry.roles.includes(role)
    );
    if (registry) {
      recordRegistryRead({ relativePath, role, tenantSlug });
      return null;
    }
  }
  const groupDenial = checkTenantGroupScope(relativePath, tenantSlug, brokeredTenants);
  if (groupDenial) return groupDenial;
  const isSharedPath = cfg.sharedPrefixes.some((prefix) => pathStartsWith(relativePath, prefix));
  // A tenant-group share (knowledge/confidential/shared/{group}/) has already
  // passed the membership check above; its `shared` segment is not a tenant.
  const isGroupPath = Boolean(extractTenantGroupFromSharedPath(relativePath));
  const scoped = extractTenantFromProtectedPrefix(relativePath, cfg.protectedPrefixes);
  const hasValidTenantSegment = Boolean(
    scoped && cfg.slugPattern.test(scoped.tenant) && isValidTenantSlug(scoped.tenant)
  );
  if (
    cfg.requireTenantBinding &&
    !tenantSlug &&
    !brokeredTenants?.length &&
    (isSharedPath || isGroupPath || hasValidTenantSegment)
  ) {
    const targetTenant =
      scoped?.tenant || extractTenantGroupFromSharedPath(relativePath) || '(shared)';
    const reason =
      `[POLICY_VIOLATION] tenant.scope_missing — access to protected tenant path '${relativePath}' ` +
      'requires a server-resolved tenant binding or an approved broker scope.';
    void recordTenantScopeViolation({ relativePath, targetTenant, reason });
    return { allowed: false, reason };
  }
  if (cfg.requireTenantBinding && tenantSlug && !isRegisteredActiveTenant(tenantSlug)) {
    const reason =
      `[POLICY_VIOLATION] tenant.inactive — tenant '${tenantSlug}' is not registered as active; ` +
      'protected tenant access is denied until activation is reconciled.';
    void recordTenantScopeViolation({ relativePath, tenantSlug, targetTenant: tenantSlug, reason });
    return { allowed: false, reason };
  }
  if (isSharedPath || isGroupPath) return null;

  if (!scoped) return null;
  if (!tenantSlug && !brokeredTenants?.length) return null;
  if (brokeredTenants?.some((tenant) => !isValidTenantSlug(tenant))) {
    return {
      allowed: false,
      reason:
        '[POLICY_VIOLATION] tenant.broker_scope_invalid — brokered tenant list contains a reserved or invalid tenant slug.',
    };
  }
  const targetTenant = scoped.tenant;
  if (!targetTenant || !cfg.slugPattern.test(targetTenant) || !isValidTenantSlug(targetTenant)) {
    // Pre-tenant migrations stored a mission directly under
    // active/missions/confidential/{MISSION_ID}/. Keep that layout usable
    // only for an unmistakable legacy mission directory. A non-slug mission
    // segment cannot name another tenant, while arbitrary malformed segments
    // must still fail closed rather than becoming an implicit escape hatch.
    const legacyMissionSegment = /^MSN-[A-Z0-9][A-Z0-9._-]{1,127}$/i.test(targetTenant);
    if (scoped.prefix === 'active/missions/confidential/' && legacyMissionSegment) {
      return null;
    }
    return {
      allowed: false,
      reason: `[POLICY_VIOLATION] tenant.scope_invalid_prefix — '${relativePath}' is under protected prefix '${scoped.prefix}' but tenant segment '${targetTenant || '(missing)'}' is invalid.`,
    };
  }

  // Same tenant → allow.
  if (tenantSlug === targetTenant) return null;

  // Brokered access: allow if target tenant is on the broker's list.
  // Side-effect: emit a broker-access audit event so the cross-tenant
  // touch is recorded even though it is permitted.
  if (brokeredTenants && brokeredTenants.includes(targetTenant)) {
    const purpose = String(brokerApproval?.purpose || '').trim();
    const approvedBy = String(brokerApproval?.approvedBy || '').trim();
    const approvedAt = String(brokerApproval?.approvedAt || '').trim();
    const expiresAt = String(brokerApproval?.expiresAt || '').trim();
    if (!purpose) {
      return {
        allowed: false,
        reason: `[POLICY_VIOLATION] tenant.broker_missing_purpose — brokered access requires cross_tenant_brokerage.purpose.`,
      };
    }
    if (cfg.brokerRequirements.requireApprovedBy && !approvedBy) {
      return {
        allowed: false,
        reason: `[POLICY_VIOLATION] tenant.broker_unapproved — brokered access requires cross_tenant_brokerage.approved_by.`,
      };
    }
    if (cfg.brokerRequirements.requireApprovedAt && !approvedAt) {
      return {
        allowed: false,
        reason: `[POLICY_VIOLATION] tenant.broker_unapproved — brokered access requires cross_tenant_brokerage.approved_at.`,
      };
    }
    if (cfg.brokerRequirements.requireExpiresAt && !expiresAt) {
      return {
        allowed: false,
        reason: `[POLICY_VIOLATION] tenant.broker_expiry_required — brokered access requires cross_tenant_brokerage.expires_at.`,
      };
    }
    if (expiresAt) {
      const expiryMs = Date.parse(expiresAt);
      if (Number.isNaN(expiryMs) || expiryMs <= Date.now()) {
        return {
          allowed: false,
          reason: `[POLICY_VIOLATION] tenant.broker_expired — brokered access expired at '${expiresAt}'.`,
        };
      }
    }
    void recordBrokerAccess({ relativePath, brokerTenants: brokeredTenants, targetTenant });
    return null;
  }

  const persona = tenantSlug ? `tenant '${tenantSlug}'` : 'a tenant-bound persona';
  const reason = `[POLICY_VIOLATION] tenant.scope_violation — persona bound to ${persona} attempted to access path of tenant '${targetTenant}' ('${relativePath}').`;
  void recordTenantScopeViolation({ relativePath, tenantSlug, targetTenant, reason });
  return { allowed: false, reason };
}

type TenantAuditEntry = Omit<AuditEntry, 'id' | 'timestamp' | 'previousHash' | 'currentHash'>;

interface TenantAuditAttempt {
  nestedDenied: boolean;
  diagnosticEmitted: boolean;
}

let activeTenantAuditAttempt: TenantAuditAttempt | undefined;
let tenantAuditModule: Promise<typeof import('./governance/audit-chain.js')> | undefined;

function reportTenantAuditFailure(attempt: TenantAuditAttempt): void {
  if (attempt.diagnosticEmitted) return;
  attempt.diagnosticEmitted = true;
  try {
    // The shared console emitter avoids the file sink (which may itself be
    // denied), and keeps this fixed, redacted failure visible in quiet/JSON mode.
    emitConsoleLine(
      'stderr',
      '[tier-guard] Tenant access audit persistence unverified — audit recording failed or encountered a nested policy denial | next: inspect tenant activation and audit persistence policy',
      { dedup: false }
    );
  } catch {
    // A broken stderr must not change the policy decision or start a retry loop.
  }
}

function recordTenantAudit(entry: TenantAuditEntry): void {
  if (activeTenantAuditAttempt) {
    if (entry.result === 'denied') activeTenantAuditAttempt.nestedDenied = true;
    return;
  }

  const attempt: TenantAuditAttempt = { nestedDenied: false, diagnosticEmitted: false };
  // Never hold the guard while the import is pending: unrelated denials queued
  // in the same turn each need their own attempt. record() and its secure I/O
  // are synchronous; only calls made inside that sink are audit-of-audit work.
  // Share native module resolution, but keep one callback/attempt per event.
  if (!tenantAuditModule) {
    const pendingModule = import('./governance/audit-chain.js');
    tenantAuditModule = pendingModule;
    void pendingModule.catch(() => {
      if (tenantAuditModule === pendingModule) tenantAuditModule = undefined;
    });
  }
  void tenantAuditModule.then(
    ({ auditChain }) => {
      activeTenantAuditAttempt = attempt;
      try {
        auditChain.record(entry);
      } catch {
        reportTenantAuditFailure(attempt);
      } finally {
        // appendToFile can catch a denied write and still return an entry, so
        // a returned record alone cannot prove persistence in this case.
        if (attempt.nestedDenied) reportTenantAuditFailure(attempt);
        activeTenantAuditAttempt = undefined;
      }
    },
    () => {
      activeTenantAuditAttempt = attempt;
      try {
        reportTenantAuditFailure(attempt);
      } finally {
        activeTenantAuditAttempt = undefined;
      }
    }
  );
}

function recordTenantScopeViolation(input: {
  relativePath: string;
  tenantSlug?: string;
  targetTenant: string;
  reason: string;
}): void {
  recordTenantAudit({
    agentId: 'tier-guard',
    action: 'tenant.scope_violation',
    operation: input.relativePath,
    result: 'denied',
    reason: input.reason,
    ...(input.tenantSlug ? { tenantSlug: input.tenantSlug } : {}),
    metadata: { target_tenant: input.targetTenant },
  });
}

/** Best-effort auditing leaves the original brokered access decision unchanged. */
function recordBrokerAccess(input: {
  relativePath: string;
  brokerTenants: string[];
  targetTenant: string;
}): void {
  recordTenantAudit({
    agentId: 'tier-guard',
    action: 'tenant.broker_access',
    operation: input.relativePath,
    result: 'allowed',
    reason: `Brokered cross-tenant access to '${input.targetTenant}' via mission allowed across {${input.brokerTenants.join(', ')}}.`,
    metadata: {
      target_tenant: input.targetTenant,
      broker_tenants: input.brokerTenants,
    },
  });
}

function recordRegistryRead(input: {
  relativePath: string;
  role: string;
  tenantSlug: string | undefined;
}): void {
  recordTenantAudit({
    agentId: 'tier-guard',
    action: 'tenant.registry_read',
    operation: input.relativePath,
    result: 'allowed',
    reason: `System registry reader '${input.role}' read cross-tenant registry '${input.relativePath}'.`,
    metadata: {
      role: input.role,
      ...(input.tenantSlug ? { tenant_slug: input.tenantSlug } : {}),
    },
  });
}

function recordGroupAccess(input: {
  relativePath: string;
  groupId: string;
  tenantSlug: string;
}): void {
  recordTenantAudit({
    agentId: 'tier-guard',
    action: 'tenant.group_access',
    operation: input.relativePath,
    result: 'allowed',
    reason: `Tenant '${input.tenantSlug}' accessed shared tenant group '${input.groupId}'.`,
    metadata: {
      tenant_slug: input.tenantSlug,
      tenant_group_id: input.groupId,
    },
  });
}

export function validateWritePermission(filePath: string): { allowed: boolean; reason?: string } {
  const resolvedPath = path.resolve(filePath);
  try {
    assertSandboxWriteAllowed(resolvedPath);
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const relativePath = normalizePath(path.relative(projectRoot(), resolvedPath));
  const currentMission = resolveProjectScope().missionId;

  if (isOutsideProjectRoot(relativePath)) {
    return {
      allowed: false,
      reason: `[POLICY_VIOLATION] Path outside project root: '${resolvedPath}'`,
    };
  }

  // 1. Identify Identity Context (Persona & Authority)
  const {
    persona: currentPersona,
    role: currentRole,
    authorities,
    sudoScope,
    tenantSlug,
    brokeredTenants,
    brokerApproval,
  } = resolvePolicyIdentityContext();

  const loaded = loadPolicy();
  if (loaded.status === 'missing') return { allowed: true };
  if (loaded.status === 'corrupt') {
    return isProtectedTierPath(relativePath) ? CORRUPT_POLICY_DENIAL : { allowed: true };
  }
  const policy = loaded.policy;

  // 1.5 Tenant scope — deny cross-tenant writes when the persona is tenant-bound.
  const tenantDenial = checkTenantScope(
    policy,
    relativePath,
    tenantSlug,
    brokeredTenants,
    brokerApproval,
    authorities
  );
  if (tenantDenial) return tenantDenial;

  if (
    (policy.default_allow || []).some((p: string) =>
      policyPathMatches(relativePath, p, currentMission)
    )
  )
    return { allowed: true };

  if (authorities.includes('SUDO') && hasScopedSudoAccess(relativePath, sudoScope))
    return { allowed: true };
  if (hasAuthorityAccess(policy, authorities, relativePath, currentMission, 'allow_write'))
    return { allowed: true };

  const roleRules = currentRole ? policy.authority_role_permissions?.[currentRole] : null;
  if (
    roleRules?.allow_write?.some((p: string) =>
      policyPathMatches(relativePath, p, currentMission, tenantSlug)
    )
  ) {
    return { allowed: true };
  }

  const personaRules = policy.persona_permissions?.[currentPersona];
  if (
    personaRules?.allow_write?.some((p: string) =>
      policyPathMatches(relativePath, p, currentMission, tenantSlug)
    )
  ) {
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
    reason: `[POLICY_VIOLATION] Persona '${currentPersona}' with authority role '${currentRole || 'unknown'}' is NOT authorized to write to '${relativePath}'.`,
  };
}

/**
 * Determine the knowledge tier of a file based on its path.
 */
export function detectTier(filePath: string): TierLevel {
  const resolved = path.resolve(filePath);
  if (
    resolved.includes('/knowledge/personal/') ||
    resolved.includes('/active/organizations/personal/') ||
    resolved.includes('/active/projects/personal/')
  )
    return 'personal';
  const floorTier = storageFloorTierInPath(resolved);
  if (floorTier) return floorTier;
  if (
    resolved.includes('/knowledge/confidential/') ||
    resolved.includes('/active/organizations/confidential/') ||
    resolved.includes('/active/projects/confidential/')
  )
    return 'confidential';
  return 'public';
}

/**
 * Validates read permission based on security-policy.json ADF and Persona.
 */
export function validateReadPermission(filePath: string): { allowed: boolean; reason?: string } {
  const resolvedPath = path.resolve(filePath);
  const relativePath = normalizePath(path.relative(projectRoot(), resolvedPath));

  if (isOutsideProjectRoot(relativePath)) {
    if (isAllowedVaultMountPath(resolvedPath)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `[POLICY_VIOLATION] Path outside project root: '${resolvedPath}'`,
    };
  }

  // Tenant-partitioned runtime state (e.g. the resource-usage ledger under
  // active/shared/runtime/usage-ledger/<tier>/<tenant>/) carries no tier read
  // gate, but a tenant-bound reader must still never cross tenants.
  if (
    pathStartsWith(relativePath, 'active/shared/runtime/') &&
    /\/(?:personal|confidential)\//u.test(relativePath)
  ) {
    const loaded = loadPolicy();
    if (loaded.status === 'loaded') {
      const cfg = tenantScopeConfig(loaded.policy);
      if (extractTenantFromProtectedPrefix(relativePath, cfg.protectedPrefixes)) {
        const identity = resolvePolicyIdentityContext();
        const denial = checkTenantScope(
          loaded.policy,
          relativePath,
          identity.tenantSlug,
          identity.brokeredTenants,
          identity.brokerApproval,
          identity.authorities,
          { kind: 'read', role: identity.role }
        );
        return denial ?? { allowed: true };
      }
    } else if (
      loaded.status === 'corrupt' &&
      pathStartsWith(relativePath, 'active/shared/runtime/usage-ledger/')
    ) {
      return CORRUPT_POLICY_DENIAL;
    }
  }

  const organizationStatePath =
    pathStartsWith(relativePath, 'active/organizations/personal') ||
    pathStartsWith(relativePath, 'active/organizations/confidential') ||
    pathStartsWith(relativePath, 'active/organizations/public');
  const projectTier = relativePath.match(
    /^active\/projects\/(personal|confidential|public)(?:\/|$)/
  )?.[1];
  const protectedProjectPath = projectTier === 'personal' || projectTier === 'confidential';
  const floorTier = storageFloorTier(relativePath);
  const protectedFloorPath = isProtectedStorageFloorTier(floorTier);
  const organizationTier = relativePath.match(
    /^active\/organizations\/(personal|confidential|public)(?:\/|$)/
  )?.[1];
  if (
    !pathStartsWith(relativePath, 'knowledge') &&
    !organizationStatePath &&
    !protectedProjectPath &&
    !protectedFloorPath
  )
    return { allowed: true };
  if (pathStartsWith(relativePath, 'knowledge/public')) return { allowed: true };

  if (
    !pathStartsWith(relativePath, 'knowledge/personal') &&
    !pathStartsWith(relativePath, 'knowledge/confidential') &&
    !organizationStatePath &&
    !protectedProjectPath &&
    !protectedFloorPath
  ) {
    return { allowed: true };
  }

  const loaded = loadPolicy();
  if (loaded.status === 'missing') return { allowed: true };
  if (loaded.status === 'corrupt') return CORRUPT_POLICY_DENIAL;
  const policy = loaded.policy;
  const currentMission = resolveProjectScope().missionId;

  const {
    persona: currentPersona,
    role: currentRole,
    authorities,
    sudoScope,
    tenantSlug,
    brokeredTenants,
    brokerApproval,
  } = resolvePolicyIdentityContext();

  // Tenant scope — deny cross-tenant reads from confidential.
  const tenantDenial = checkTenantScope(
    policy,
    relativePath,
    tenantSlug,
    brokeredTenants,
    brokerApproval,
    authorities,
    { kind: 'read', role: currentRole }
  );
  if (tenantDenial) return tenantDenial;

  if (authorities.includes('SUDO') && hasScopedSudoAccess(relativePath, sudoScope))
    return { allowed: true };
  const floorPartitionPrefix = protectedFloorPartitionPrefix(relativePath);
  const grants = (patterns: string[] | undefined): boolean =>
    (patterns || []).some((p: string) =>
      readGrantMatches(relativePath, p, currentMission, tenantSlug, floorPartitionPrefix)
    );
  for (const accessType of ['allow_read', 'allow_write'] as const) {
    if (
      hasAuthorityAccess(
        policy,
        authorities,
        relativePath,
        currentMission,
        accessType,
        floorPartitionPrefix
      )
    )
      return { allowed: true };
  }

  const roleRules = currentRole ? policy.authority_role_permissions?.[currentRole] : null;
  if (grants(roleRules?.allow_read) || grants(roleRules?.allow_write)) return { allowed: true };

  const personaRules = policy.persona_permissions?.[currentPersona];
  if (grants(personaRules?.allow_read) || grants(personaRules?.allow_write))
    return { allowed: true };

  // Project scope check for confidential tier (before generic tier restrictions)
  const projectDenial = checkProjectScope(relativePath, policy, currentPersona, authorities);
  if (projectDenial) return projectDenial;

  if (pathStartsWith(relativePath, 'knowledge/personal')) {
    return { allowed: false, reason: policy.tier_restrictions.personal.block_message };
  }
  if (pathStartsWith(relativePath, 'knowledge/confidential')) {
    return { allowed: false, reason: policy.tier_restrictions.confidential.block_message };
  }
  if (organizationTier === 'personal') {
    return { allowed: false, reason: policy.tier_restrictions.personal.block_message };
  }
  if (organizationTier === 'confidential') {
    return { allowed: false, reason: policy.tier_restrictions.confidential.block_message };
  }
  if (projectTier === 'personal') {
    return { allowed: false, reason: policy.tier_restrictions.personal.block_message };
  }
  if (projectTier === 'confidential') {
    return { allowed: false, reason: policy.tier_restrictions.confidential.block_message };
  }
  if (floorTier === 'personal') {
    return { allowed: false, reason: policy.tier_restrictions.personal.block_message };
  }
  if (floorTier === 'confidential') {
    return { allowed: false, reason: policy.tier_restrictions.confidential.block_message };
  }

  return { allowed: true };
}

export function validateSovereignBoundary(
  content: string,
  activeSecrets: string[] = []
): { safe: boolean; detected: string[] } {
  if (!content || activeSecrets.length === 0) return { safe: true, detected: [] };
  const detected: string[] = [];
  for (const secret of activeSecrets) {
    if (secret && content.includes(secret)) {
      const masked =
        secret.length <= 8 ? '********' : `${secret.slice(0, 4)}...${secret.slice(-4)}`;
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
    } catch (err) {
      logger.warn(`marker pattern '${pattern.name}' failed to compile and is not enforced: ${err}`);
    }
  }
  return { hasMarkers: markers.length > 0, markers };
}

function loadMarkerPatterns(): { name: string; regex: string }[] {
  const patterns: { name: string; regex: string }[] = [];
  try {
    const policyPath = pathResolver.knowledge('product/governance/knowledge-sync-rules.json');
    if (rawExistsSync(policyPath)) {
      const rules = parseSafeJsonObjectInput(rawReadTextFile(policyPath), 'knowledge sync rules');
      if (!rules) return patterns;
      const security = isRecord(rules) && isRecord(rules.security) ? rules.security : null;
      const pii = security?.pii_patterns;
      if (!Array.isArray(pii)) return patterns;
      for (const p of pii) {
        if (isRecord(p) && typeof p.name === 'string' && typeof p.regex === 'string') {
          patterns.push({ name: p.name, regex: p.regex });
        }
      }
    }
  } catch (err) {
    logger.warn(
      `knowledge-sync-rules.json PII patterns unavailable — marker scan degraded: ${err}`
    );
  }
  return patterns;
}
