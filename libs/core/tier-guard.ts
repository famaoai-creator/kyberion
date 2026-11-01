import { engineRuntimeResourceAccessDenial as resourceAccessDenial } from './voice/engine-runtime-preferences-access.js';
import { personCharterResourceAccessAllowed } from './governance/person-charter-runtime.js';
import {
  prPublicationResourceAllowed,
  PR_PUBLICATION_STORE_ROLE,
  currentPrPublicationScope,
} from './governance/pr-publication-runtime.js';
import {
  isDiscussionRequestCapability,
  DISCUSSION_REQUEST_STORAGE_ROLE,
} from './foundation/discussion-request-capability.js';
import { isAutonomyLearningCapability } from './foundation/autonomy-learning-capability.js';
import {
  DOT_RESULT_STORE_ROLE,
  isDotResultStoreCapability,
} from './foundation/dot-result-store-capability.js';
import {
  MEMORY_PROVENANCE_READER_ROLE,
  memoryProvenanceReadAllowed,
  isMemoryProvenanceStatePath,
} from './knowledge/memory-provenance-capability.js';
import {
  isPipelineJournalCapability,
  PIPELINE_JOURNAL_STORE_ROLE,
} from './foundation/pipeline-journal-capability.js';
import {
  isCustomerDecisionInviteCapability,
  CUSTOMER_DECISION_INVITE_STORE_ROLE,
} from './foundation/customer-decision-invite-capability.js';
import {
  isCustomerDecisionConsumerCapability,
  CUSTOMER_DECISION_CONSUMER_STORE_ROLE,
} from './foundation/customer-decision-consumer-capability.js';
import {
  isCustomerDecisionMilestoneCapability,
  CUSTOMER_DECISION_MILESTONE_STORE_ROLE,
} from './foundation/customer-decision-milestone-capability.js';
import { narrowStoreRoleDenial } from './foundation/narrow-store-role-denial.js';
import type { WriteContent } from './foundation/customer-decision-write-content.js';
/**
 * TypeScript version of the Knowledge Tier Guard.
 * v2.2 - POLICY-AS-CODE (ADF DRIVEN) with Persona Integration
 */

import * as path from 'node:path';
import { getRegisteredEnvBool, getRegisteredEnvText } from './foundation/env.js';
import { parseSafeJsonObjectInput, parseSafeJsonInput } from './foundation/safe-json.js';
import { isRecord } from './foundation/text.js';
import { pathResolver } from './path-resolver.js';
import { rawExistsSync, rawReadTextFile, rawRealpathSync } from './fs-primitives.js';
import { resolveProjectScope, resolveProjectScopeId } from './foundation/project-scope-env.js';
import { resolvePolicyIdentityContext } from './identity-context-bridge.js';
import { createLogger, emitConsoleLine } from './logger.js';
import type { AuditEntry } from './governance/audit-chain.js';
import { isValidTenantSlug } from './entity-scope.js';
import {
  PARTITIONED_RUNTIME_LEDGER_ROOTS,
  PARTITIONED_RUNTIME_STATE_ROOTS,
  partitionedRuntimeStateKnowledgePath,
  partitionedRuntimeStateTierInPath,
  STORAGE_FLOOR_ROOTS,
  classifyStorageFloorPath,
  storageFloorTier,
  storageFloorTierInPath,
} from './storage-layout.js';
import { assertSandboxWriteAllowed } from './shell/sandbox-policy.js';
import {
  tenantStorePartitionWriteDecision,
  tenantScopeConfig,
  normalizeTenantPolicyPath as normalizePath,
  tenantPolicyPathStartsWith as pathStartsWith,
  normalizeRegisteredTenantProfile,
  isValidTenantGroupProfile,
  extractTenantGroupFromSharedPath,
  type TenantGroupProfile,
} from './tier-guard-tenant-store-partitions.js';
export {
  normalizeRegisteredTenantProfile,
  isValidTenantGroupProfile,
} from './tier-guard-tenant-store-partitions.js';
import { isAllowedVaultMountPath } from './secret/vault-mount.js';
import { currentExecutionScope } from './foundation/execution-scope.js';
import {
  currentResourceAccessScope,
  matchesNamePrefix,
  type ResourceAccessOperation,
} from './foundation/resource-access-scope.js';
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
export { KNOWLEDGE_TIER_RANK as TIERS } from './foundation/knowledge-tier.js';

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

function isOutsideProjectRoot(relativePath: string): boolean {
  if (!relativePath) return false;
  const firstSegment = normalizePath(relativePath).split('/')[0];
  return firstSegment === '..';
}

const logger = createLogger('tier-guard');

type PolicyLoad = { status: 'loaded'; policy: any } | { status: 'missing' } | { status: 'corrupt' };

let corruptPolicyWarned = false;

/**
 * A missing policy preserves bootstrap access outside protected durable state.
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
    isProtectedStorageFloorTier(storageFloorTier(relativePath)) ||
    isProtectedRuntimeStatePath(relativePath)
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

/** Exact registered durable-state root; copies in scratch keep their own boundary. */
function isProtectedRuntimeStatePath(relativePath: string): boolean {
  return (
    Boolean(partitionedRuntimeStateKnowledgePath(relativePath)) &&
    isProtectedStorageFloorTier(partitionedRuntimeStateTierInPath(relativePath))
  );
}

const MISSING_RUNTIME_STATE_POLICY_DENIAL = {
  allowed: false as const,
  reason:
    '[POLICY_VIOLATION] security-policy.json is missing. Access to protected durable runtime state fails closed until the policy file is restored.',
};

/** A stale but parseable policy must not turn a registered state store public.
 * Require the exact tier declaration to be the first matching protected prefix:
 * an earlier ancestor would extract the wrong tenant. Shared exemptions cannot
 * bypass this store's tenant check. Other stores keep their existing semantics.
 */
function runtimeStatePolicyDeclarationValid(
  policy: { tenant_scope?: { protected_prefixes?: unknown; shared_prefixes?: unknown } } | null,
  relativePath: string
): boolean {
  if (!isProtectedRuntimeStatePath(relativePath)) return true;
  const root = Object.values(PARTITIONED_RUNTIME_STATE_ROOTS).find((candidate) =>
    pathStartsWith(relativePath, candidate)
  );
  const tier = partitionedRuntimeStateTierInPath(relativePath);
  const protectedPrefixes: unknown = policy?.tenant_scope?.protected_prefixes;
  const sharedPrefixes: unknown = policy?.tenant_scope?.shared_prefixes;
  return (
    Array.isArray(protectedPrefixes) &&
    protectedPrefixes.every((prefix) => typeof prefix === 'string') &&
    protectedPrefixes.find((prefix) => pathStartsWith(relativePath, prefix)) ===
      root + '/' + tier + '/' &&
    (sharedPrefixes === undefined ||
      (Array.isArray(sharedPrefixes) &&
        sharedPrefixes.every((prefix) => typeof prefix === 'string') &&
        !sharedPrefixes.some((prefix) => pathStartsWith(relativePath, prefix))))
  );
}

const INVALID_RUNTIME_STATE_POLICY_DECLARATION_DENIAL = {
  allowed: false as const,
  reason:
    '[POLICY_VIOLATION] hearing.policy_declaration_invalid — protected durable state requires an exact tier/tenant declaration without a shared exemption in security-policy.json.',
};

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
 * Comparison key for a `deny_read` carve-out: Unicode-NFC and case-folded.
 * The default APFS/NTFS volumes are case- and normalization-insensitive, so
 * `.../Connections/x` opens the same file as `.../connections/x`; a deny that
 * only matched the literal spelling would let a broader allow grant reach the
 * carved-out file. Folding both sides over-denies on case-sensitive volumes,
 * which is the fail-closed direction. Never use this for allow matching.
 */
function denyComparisonKey(value: string): string {
  return normalizePath(value).normalize('NFC').toLowerCase();
}

/**
 * Project-relative spellings a deny carve-out must be checked against: the
 * lexically resolved path (`..` already collapsed by `path.resolve`) and, when
 * the path or an ancestor exists, its physical location (symlinks resolved via
 * the nearest existing ancestor). The project root is realpath'd as well so a
 * symlinked checkout does not make every physical path look outside the root.
 */
function denyCandidatePaths(relativePath: string): string[] {
  const candidates = [relativePath];
  const root = projectRoot();
  let physicalRoot = root;
  try {
    physicalRoot = rawRealpathSync(root);
  } catch {
    // Unresolvable root: the lexical candidate is the only one available.
  }
  let existing = path.resolve(root, relativePath);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = rawRealpathSync(existing);
      const physical = path.join(real, ...rest);
      for (const base of new Set([physicalRoot, root])) {
        const rel = normalizePath(path.relative(base, physical));
        if (!isOutsideProjectRoot(rel) && !path.isAbsolute(rel)) candidates.push(rel);
      }
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
  return [...new Set(candidates)];
}

/**
 * Does a role `deny_read` pattern cover this path? Matched case-insensitively
 * on every resolved spelling of the path (see denyCandidatePaths): a deny
 * carve-out must hold however the caller spells the path.
 */
function denyPatternMatches(
  candidates: readonly string[],
  pattern: string,
  missionId?: string,
  tenantSlug?: string
): boolean {
  const expanded = expandPolicyPath(pattern, missionId, tenantSlug);
  if (expanded === null) return false;
  const p = denyComparisonKey(expanded);
  return candidates.some((candidate) => {
    const t = denyComparisonKey(candidate);
    return t === p || t.startsWith(p + '/');
  });
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

/** Proven tenant ownership for publication provenance, never an access grant.
 * Shared policy exceptions, group shares and cross-tenant registries have no
 * single tenant owner even when their first segment happens to be a valid slug. */
export function isTenantOwnedPolicyPath(relativePath: string, tenantSlug: string): boolean {
  const loaded = loadPolicy();
  if (loaded.status !== 'loaded' || !isValidTenantSlug(tenantSlug)) return false;
  const cfg = tenantScopeConfig(loaded.policy, false);
  if (
    cfg.sharedPrefixes.some((prefix) => pathStartsWith(relativePath, prefix)) ||
    cfg.systemRegistryReads.some((entry) => pathStartsWith(relativePath, entry.path)) ||
    extractTenantGroupFromSharedPath(relativePath)
  )
    return false;
  const scoped = extractTenantFromProtectedPrefix(relativePath, cfg.protectedPrefixes);
  return (
    scoped?.tenant === tenantSlug &&
    cfg.slugPattern.test(tenantSlug) &&
    isRegisteredActiveTenant(tenantSlug)
  );
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
 * A scoped management write may need to create the shared structural tier
 * directory before its own tenant directory exists. This is only a tenant
 * classification exception; the ordinary role policy must still authorize it.
 */
function isScopedStructuralMkdir(
  relativePath: string,
  protectedPrefix: string,
  tenantSlug: string | undefined,
  access: { kind: 'read' | 'write' | 'append' | 'mkdir'; role?: string }
): boolean {
  if (access.kind !== 'mkdir') return false;
  if (access.role === DOT_RESULT_STORE_ROLE)
    return Boolean(
      tenantSlug &&
      isRegisteredActiveTenant(tenantSlug) &&
      currentResourceAccessScope()?.tenantSlug === tenantSlug &&
      isDotResultStoreCapability(currentResourceAccessScope(), {
        rootDir: projectRoot(),
        target: relativePath,
        operation: 'mkdir',
      })
    );
  if (access.role === PR_PUBLICATION_STORE_ROLE) {
    const publication = currentPrPublicationScope();
    return (
      publication?.kind === 'organization' &&
      publication.tenant_slug === tenantSlug &&
      [
        `${STORAGE_FLOOR_ROOTS.artifact}/confidential`,
        `${PARTITIONED_RUNTIME_STATE_ROOTS.external_operations}/confidential`,
      ].includes(relativePath) &&
      prPublicationResourceAllowed(relativePath, 'mkdir')
    );
  }
  if (access.role === DISCUSSION_REQUEST_STORAGE_ROLE) {
    if (
      !isDiscussionRequestCapability(currentResourceAccessScope()) ||
      normalizePath(protectedPrefix) !==
        PARTITIONED_RUNTIME_STATE_ROOTS.discussion_create_requests + '/confidential'
    )
      return false;
  } else if (access.role === 'autonomy_learning_store') {
    if (
      !isAutonomyLearningCapability(currentResourceAccessScope()) ||
      normalizePath(protectedPrefix) !==
        PARTITIONED_RUNTIME_STATE_ROOTS.autonomy_learning + '/confidential'
    )
      return false;
  } else if (access.role === PIPELINE_JOURNAL_STORE_ROLE) {
    if (
      !isPipelineJournalCapability(currentResourceAccessScope()) ||
      normalizePath(protectedPrefix) !==
        PARTITIONED_RUNTIME_STATE_ROOTS.pipeline_library_runs + '/confidential'
    )
      return false;
  } else if (access.role === CUSTOMER_DECISION_INVITE_STORE_ROLE) {
    if (
      !isCustomerDecisionInviteCapability(currentResourceAccessScope()) ||
      normalizePath(protectedPrefix) !==
        PARTITIONED_RUNTIME_STATE_ROOTS.customer_decision_invites + '/confidential'
    )
      return false;
  } else if (access.role !== 'concierge_management_writer') return false;
  const resource = currentResourceAccessScope();
  if (
    !tenantSlug ||
    !isValidTenantSlug(tenantSlug) ||
    resource?.tenantSlug !== tenantSlug ||
    relativePath !== normalizePath(protectedPrefix) ||
    !resource.mkdirExact.includes(relativePath) ||
    resourceAccessDenial(relativePath, 'mkdir') ||
    !isRegisteredActiveTenant(tenantSlug)
  )
    return false;
  const tenantPrefix = normalizePath(protectedPrefix) + '/' + tenantSlug + '/';
  return resource.writeExact.some(
    (target) => target.startsWith(tenantPrefix) && !resourceAccessDenial(target, 'write')
  );
}

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
  access: { kind: 'read' | 'write' | 'append' | 'mkdir'; role?: string } = { kind: 'write' }
): { allowed: boolean; reason?: string } | null {
  if (authorities.includes('SUDO')) return null;
  const cfg = tenantScopeConfig(
    policy,
    getRegisteredEnvBool('KYBERION_TENANT_SCOPE_REQUIRED') === true
  );
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
    if (isScopedStructuralMkdir(relativePath, scoped.prefix, tenantSlug, access)) return null;
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

export type { WriteContent };

function requestResourceDenial(
  relativePath: string,
  operation: ResourceAccessOperation,
  content?: WriteContent
): { allowed: false; reason: string } | null {
  const denial = resourceAccessDenial(relativePath, operation);
  if (denial) return denial;
  const role =
    currentExecutionScope()?.assumedRole ||
    getRegisteredEnvText('SYSTEM_ROLE') ||
    getRegisteredEnvText('MISSION_ROLE');
  const normalizedRole = role?.trim().toLowerCase().replace(/\s+/gu, '_');
  if (
    normalizedRole === DOT_RESULT_STORE_ROLE &&
    !denyCandidatePaths(relativePath).every((target) =>
      isDotResultStoreCapability(currentResourceAccessScope(), {
        rootDir: projectRoot(),
        target,
        operation,
      })
    )
  )
    return {
      allowed: false,
      reason:
        '[DOT_RESULT_CAPABILITY_REQUIRED] Active exact DOT result operation capability required',
    };
  // Old dedicated-store capability validators predate appendExact. An added append path
  // cannot enlarge their original write or metadata ceiling, even under ambient grants.
  // Name prefixes count only for a validator that checks them (`withNamePrefixes`).
  const legacyStoreCapability = (valid: boolean, withNamePrefixes = false): boolean => {
    if (!valid) return false;
    const scope = currentResourceAccessScope();
    if (!scope) return false;
    if (!withNamePrefixes && (scope.namePrefixExact?.length ?? 0) > 0) return false;
    const candidates = denyCandidatePaths(relativePath);
    const prefixed = (target: string): boolean =>
      withNamePrefixes && operation !== 'mkdir' && matchesNamePrefix(scope, target);
    if (operation === 'append')
      return candidates.every((target) => scope.writeExact.includes(target) || prefixed(target));
    if (operation === 'metadata') {
      const original = [
        ...(scope.metadataExact ?? []),
        ...scope.readExact,
        ...scope.writeExact,
        ...scope.mkdirExact,
      ];
      return candidates.every(
        (target) =>
          prefixed(target) ||
          original.some(
            (allowed) => target === allowed || target === '' || allowed.startsWith(target + '/')
          ) ||
          (scope.allowProductKnowledgeRead === true &&
            (target === 'knowledge' ||
              target === 'knowledge/product' ||
              target.startsWith('knowledge/product/')))
      );
    }
    return true;
  };
  if (
    normalizedRole === MEMORY_PROVENANCE_READER_ROLE &&
    !memoryProvenanceReadAllowed(relativePath, operation)
  )
    return {
      allowed: false,
      reason: '[MEMORY_PROVENANCE_READ_SCOPE] Read-only exact lineage capability required',
    };
  if (
    (operation === 'write' || operation === 'append' || operation === 'mkdir') &&
    isMemoryProvenanceStatePath(relativePath) &&
    !['mission_controller', 'knowledge_steward', 'chronos_gateway'].includes(normalizedRole || '')
  )
    return {
      allowed: false,
      reason: '[MEMORY_PROVENANCE_AUTHORITY] Lineage is outside worker-mutable state',
    };
  if (
    normalizedRole === PR_PUBLICATION_STORE_ROLE &&
    !denyCandidatePaths(relativePath).every((target) =>
      prPublicationResourceAllowed(target, operation)
    )
  )
    return {
      allowed: false,
      reason: '[PR_PUBLICATION_SCOPE] Publication store requires exact host resource capability',
    };
  if (
    normalizedRole === 'person_charter_store' &&
    !denyCandidatePaths(relativePath).every((target) =>
      personCharterResourceAccessAllowed(target, operation)
    )
  )
    return {
      allowed: false,
      reason:
        '[PERSON_CHARTER_RESOURCE_DENIED] Person charter IO requires its installed owner and exact resource capability',
    };
  if (
    normalizedRole === 'autonomy_learning_store' &&
    !legacyStoreCapability(isAutonomyLearningCapability(currentResourceAccessScope()), true)
  ) {
    return {
      allowed: false,
      reason:
        '[RESOURCE_SCOPE_REQUIRED] Autonomy learning access requires its exact tenant store capability',
    };
  }
  if (
    normalizedRole === DISCUSSION_REQUEST_STORAGE_ROLE &&
    !legacyStoreCapability(isDiscussionRequestCapability(currentResourceAccessScope()))
  )
    return {
      allowed: false,
      reason:
        '[RESOURCE_SCOPE_REQUIRED] Discussion receipt access requires its exact tenant request capability',
    };
  if (
    normalizedRole === PIPELINE_JOURNAL_STORE_ROLE &&
    !legacyStoreCapability(isPipelineJournalCapability(currentResourceAccessScope()))
  )
    return {
      allowed: false,
      reason:
        '[RESOURCE_SCOPE_REQUIRED] Pipeline journal access requires its exact tenant journal capability',
    };
  if (
    normalizedRole === CUSTOMER_DECISION_INVITE_STORE_ROLE &&
    !legacyStoreCapability(isCustomerDecisionInviteCapability(currentResourceAccessScope()))
  )
    return {
      allowed: false,
      reason:
        '[RESOURCE_SCOPE_REQUIRED] Customer decision invite access requires its exact tenant invite capability',
    };
  if (
    normalizedRole === CUSTOMER_DECISION_CONSUMER_STORE_ROLE &&
    !legacyStoreCapability(isCustomerDecisionConsumerCapability(currentResourceAccessScope()))
  )
    return {
      allowed: false,
      reason:
        '[RESOURCE_SCOPE_REQUIRED] Customer decision consumer lock access requires its exact case capability',
    };
  if (
    normalizedRole === CUSTOMER_DECISION_MILESTONE_STORE_ROLE &&
    !legacyStoreCapability(isCustomerDecisionMilestoneCapability(currentResourceAccessScope()))
  )
    return {
      allowed: false,
      reason:
        '[RESOURCE_SCOPE_REQUIRED] Customer decision milestone access requires its exact case capability',
    };
  const narrowDenial = narrowStoreRoleDenial({
    role: normalizedRole,
    relativePath,
    operation,
    scope: currentResourceAccessScope(),
    content,
    readRepoFile: (relative) => {
      const target = path.join(projectRoot(), relative);
      return rawExistsSync(target) ? rawReadTextFile(target) : undefined;
    },
  });
  if (narrowDenial) return { allowed: false, reason: narrowDenial };
  if (
    normalizedRole === 'concierge_management_reader' &&
    (!currentResourceAccessScope() ||
      operation === 'write' ||
      operation === 'append' ||
      operation === 'mkdir')
  ) {
    return {
      allowed: false,
      reason: '[RESOURCE_SCOPE_REQUIRED] Management reader needs a read-only tenant capability',
    };
  }
  if (
    normalizedRole === 'concierge_management_writer' &&
    !currentResourceAccessScope()?.organizationId
  ) {
    return {
      allowed: false,
      reason: '[RESOURCE_SCOPE_REQUIRED] Management writer needs a bound request capability',
    };
  }
  return null;
}

export function validateWritePermission(
  filePath: string,
  operation: 'write' | 'append' | 'mkdir' = 'write',
  content?: WriteContent
): { allowed: boolean; reason?: string } {
  const resolvedPath = path.resolve(filePath);
  const resourceDenial = requestResourceDenial(
    normalizePath(path.relative(projectRoot(), resolvedPath)),
    operation,
    content
  );
  if (resourceDenial) return resourceDenial;
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
  const identity = resolvePolicyIdentityContext();
  const { role: currentRole, authorities, tenantSlug, brokeredTenants, brokerApproval } = identity;

  const loaded = loadPolicy();
  if (loaded.status === 'missing') {
    return isProtectedRuntimeStatePath(relativePath)
      ? MISSING_RUNTIME_STATE_POLICY_DENIAL
      : { allowed: true };
  }
  if (loaded.status === 'corrupt') {
    return isProtectedTierPath(relativePath) ? CORRUPT_POLICY_DENIAL : { allowed: true };
  }
  const policy = loaded.policy;
  if (!runtimeStatePolicyDeclarationValid(policy, relativePath)) {
    return INVALID_RUNTIME_STATE_POLICY_DECLARATION_DENIAL;
  }

  // 1.5 Tenant scope — deny cross-tenant writes when the persona is tenant-bound.
  const tenantDenial = checkTenantScope(
    policy,
    relativePath,
    tenantSlug,
    brokeredTenants,
    brokerApproval,
    authorities,
    { kind: operation, role: currentRole }
  );
  if (tenantDenial) return tenantDenial;

  // Durable state contains tier data; broad runtime defaults must not grant
  // knowledge-tier writes that this identity does not already possess.
  const stateKnowledgePath = partitionedRuntimeStateKnowledgePath(relativePath);
  if (
    stateKnowledgePath &&
    isProtectedStorageFloorTier(partitionedRuntimeStateTierInPath(relativePath))
  ) {
    // Dedicated receipt/publication roles grant only their bound real paths,
    // never knowledge-tier writes.
    // The exact request ceiling was checked before all ambient/default policy grants.
    if (
      (currentRole === DOT_RESULT_STORE_ROLE &&
        isDotResultStoreCapability(currentResourceAccessScope(), {
          rootDir: projectRoot(),
          target: relativePath,
          operation,
        })) ||
      (currentRole === DISCUSSION_REQUEST_STORAGE_ROLE &&
        isDiscussionRequestCapability(currentResourceAccessScope())) ||
      (currentRole === CUSTOMER_DECISION_INVITE_STORE_ROLE &&
        isCustomerDecisionInviteCapability(currentResourceAccessScope())) ||
      (currentRole === PR_PUBLICATION_STORE_ROLE &&
        prPublicationResourceAllowed(relativePath, operation))
    )
      return personaTierWriteDecision(policy, relativePath, identity, operation);
    return personaTierWriteDecision(policy, stateKnowledgePath, identity, operation);
  }

  // Dedicated-store tenant partitions skip runtime defaults (tier-guard-tenant-store-partitions.ts).
  const storeDecision = tenantStorePartitionWriteDecision(policy, relativePath, identity, {
    operation,
    sudoAllows: (scope) => hasScopedSudoAccess(relativePath, scope),
    matches: (p) => policyPathMatches(relativePath, p, currentMission, tenantSlug),
  });
  if (storeDecision) return storeDecision;

  if (
    (policy.default_allow || []).some((p: string) =>
      policyPathMatches(relativePath, p, currentMission)
    )
  )
    return { allowed: true };

  return personaTierWriteDecision(policy, relativePath, identity, operation);
}

/** Existing persona/role/authority write rules, also used by durable tier state. */
function personaTierWriteDecision(
  policy: any,
  relativePath: string,
  identity: ReturnType<typeof resolvePolicyIdentityContext>,
  operation: 'write' | 'append' | 'mkdir'
): { allowed: boolean; reason?: string } {
  const {
    persona: currentPersona,
    role: currentRole,
    authorities,
    sudoScope,
    tenantSlug,
  } = identity;
  const currentMission = resolveProjectScope().missionId;
  if (authorities.includes('SUDO') && hasScopedSudoAccess(relativePath, sudoScope))
    return { allowed: true };
  if (hasAuthorityAccess(policy, authorities, relativePath, currentMission, 'allow_write'))
    return { allowed: true };

  const roleRules = currentRole ? policy.authority_role_permissions?.[currentRole] : null;
  if (
    roleRules?.allow_write?.some(
      (p: string) =>
        policyPathMatches(relativePath, p, currentMission, tenantSlug) ||
        (operation === 'mkdir' &&
          Boolean(currentResourceAccessScope()) &&
          (expandPolicyPath(p, currentMission, tenantSlug)?.startsWith(relativePath + '/') ??
            false))
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
  const stateTier = partitionedRuntimeStateTierInPath(resolved);
  if (stateTier) return stateTier;
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
export interface ReadPermissionDecision {
  allowed: boolean;
  reason?: string;
  /** Only a generic personal-tier restriction, after resource/tenant/role checks. */
  denialKind?: 'tier_restriction';
}

/** Inspect a read decision without broadening any grant or probing file existence. */
export function inspectReadPermission(
  filePath: string,
  operation: 'read' | 'metadata' = 'read'
): ReadPermissionDecision {
  const resolvedPath = path.resolve(filePath);
  const relativePath = normalizePath(path.relative(projectRoot(), resolvedPath));
  const resourceDenial = requestResourceDenial(relativePath, operation);
  if (resourceDenial) return resourceDenial;

  if (isOutsideProjectRoot(relativePath)) {
    if (isAllowedVaultMountPath(resolvedPath)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `[POLICY_VIOLATION] Path outside project root: '${resolvedPath}'`,
    };
  }

  // Tier/tenant-partitioned runtime ledgers and durable state stores hold
  // tier data outside knowledge/: a tenant-bound reader never crosses tenants,
  // and a persona reads a partition only if it may read knowledge/<tier>/.
  if (
    pathStartsWith(relativePath, 'active/shared/runtime/') &&
    (/\/(?:personal|confidential)\//u.test(relativePath) ||
      isProtectedStorageFloorTier(partitionedRuntimeStateTierInPath(relativePath)))
  ) {
    const loaded = loadPolicy();
    if (loaded.status === 'missing' && isProtectedRuntimeStatePath(relativePath)) {
      return MISSING_RUNTIME_STATE_POLICY_DENIAL;
    }
    if (loaded.status === 'loaded') {
      if (!runtimeStatePolicyDeclarationValid(loaded.policy, relativePath)) {
        return INVALID_RUNTIME_STATE_POLICY_DECLARATION_DENIAL;
      }
      const cfg = tenantScopeConfig(
        loaded.policy,
        getRegisteredEnvBool('KYBERION_TENANT_SCOPE_REQUIRED') === true
      );
      const protectedMatch = extractTenantFromProtectedPrefix(relativePath, cfg.protectedPrefixes);
      if (protectedMatch) {
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
        if (denial) return denial;
        // The ledger allow decisions below judge a knowledge mirror path; the
        // role's deny_read carve-outs must still see the real ledger path.
        const roleDenial = roleDenyReadDecision(loaded.policy, relativePath, identity);
        if (roleDenial) return roleDenial;
        const ledgerTier = partitionedRuntimeTier(protectedMatch.prefix);
        if (!ledgerTier) return { allowed: true };
        // A narrow governed reader role (e.g. metrics_cap_reader, assumed by
        // libs/core for cap enforcement) holds an explicit read grant on the
        // ledger root itself; it never widens knowledge/ access.
        if (
          ((identity.role === DOT_RESULT_STORE_ROLE &&
            isDotResultStoreCapability(currentResourceAccessScope(), {
              rootDir: projectRoot(),
              target: relativePath,
              operation,
            })) ||
            (identity.role === DISCUSSION_REQUEST_STORAGE_ROLE &&
              isDiscussionRequestCapability(currentResourceAccessScope())) ||
            (identity.role === CUSTOMER_DECISION_INVITE_STORE_ROLE &&
              isCustomerDecisionInviteCapability(currentResourceAccessScope())) ||
            (identity.role === PR_PUBLICATION_STORE_ROLE &&
              prPublicationResourceAllowed(relativePath, operation))) &&
          loaded.policy.authority_role_permissions?.[identity.role]?.allow_read?.some(
            (pattern: string) => {
              const expanded = expandPolicyPath(
                pattern,
                resolveProjectScope().missionId,
                identity.tenantSlug
              );
              return expanded !== null && pathStartsWith(relativePath, expanded);
            }
          )
        )
          return { allowed: true };
        if (ledgerRoleReadGrant(loaded.policy, relativePath, identity)) return { allowed: true };
        // The partition mirrors knowledge/<tier>/<tenant>/ (knowledge/<tier>/ for
        // the untenanted `shared` segment), so tenant-scoped roles that may read
        // their own tenant's knowledge also read their own tenant's partition.
        const ledgerTenant = protectedMatch.tenant;
        const knowledgeMirror =
          ledgerTenant && ledgerTenant !== 'shared'
            ? `knowledge/${ledgerTier}/${ledgerTenant}`
            : `knowledge/${ledgerTier}`;
        return personaTierReadDecision(loaded.policy, knowledgeMirror, identity);
      }
    } else if (
      loaded.status === 'corrupt' &&
      [
        ...Object.values(PARTITIONED_RUNTIME_LEDGER_ROOTS),
        ...Object.values(PARTITIONED_RUNTIME_STATE_ROOTS),
      ].some((root) => pathStartsWith(relativePath, root))
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
  // Mission dirs (active and archived) partition as <tier>/<tenant|shared>/<id>
  // — putting confidential/personal mission paths on the protected set makes
  // checkTenantScope deny cross-tenant reads at the io layer. The tier block in
  // personaTierReadDecision stays archive-only: active mission dirs keep their
  // app-layer (owner-scope) authorization for persona/tier, so own-tenant and
  // unbound readers behave exactly as before.
  const missionTier = relativePath.match(
    /^active\/(?:archive\/)?missions\/(personal|confidential|public)(?:\/|$)/
  )?.[1];
  const protectedMissionPath = missionTier === 'personal' || missionTier === 'confidential';
  const floorTier = storageFloorTier(relativePath);
  const protectedFloorPath = isProtectedStorageFloorTier(floorTier);
  if (
    !pathStartsWith(relativePath, 'knowledge') &&
    !organizationStatePath &&
    !protectedProjectPath &&
    !protectedMissionPath &&
    !protectedFloorPath
  )
    return { allowed: true };
  if (pathStartsWith(relativePath, 'knowledge/public')) return { allowed: true };

  if (
    !pathStartsWith(relativePath, 'knowledge/personal') &&
    !pathStartsWith(relativePath, 'knowledge/confidential') &&
    !organizationStatePath &&
    !protectedProjectPath &&
    !protectedMissionPath &&
    !protectedFloorPath
  ) {
    return { allowed: true };
  }

  const loaded = loadPolicy();
  if (loaded.status === 'missing') return { allowed: true };
  if (loaded.status === 'corrupt') return CORRUPT_POLICY_DENIAL;
  const policy = loaded.policy;
  const identity = resolvePolicyIdentityContext();

  // Tenant scope — deny cross-tenant reads from confidential.
  const tenantDenial = checkTenantScope(
    policy,
    relativePath,
    identity.tenantSlug,
    identity.brokeredTenants,
    identity.brokerApproval,
    identity.authorities,
    { kind: 'read', role: identity.role }
  );
  if (tenantDenial) return tenantDenial;

  if (operation === 'metadata' && currentResourceAccessScope() && identity.role) {
    const rules = policy.authority_role_permissions?.[identity.role];
    const patterns: string[] = [...(rules?.allow_read ?? []), ...(rules?.allow_write ?? [])];
    if (
      patterns.some((pattern) =>
        expandPolicyPath(pattern, undefined, identity.tenantSlug)?.startsWith(relativePath + '/')
      )
    ) {
      return { allowed: true };
    }
  }
  return personaTierReadDecision(policy, relativePath, identity);
}

/** Preserve the established public permission result shape. */
export function validateReadPermission(
  filePath: string,
  operation: 'read' | 'metadata' = 'read'
): { allowed: boolean; reason?: string } {
  const { denialKind: _denialKind, ...decision } = inspectReadPermission(filePath, operation);
  return decision;
}

/**
 * Tier of a partitioned runtime ledger or durable state's protected prefix
 * (`active/shared/runtime/<ledger>/<tier>/`), or undefined for any other prefix.
 */
function partitionedRuntimeTier(prefix: string): 'personal' | 'confidential' | undefined {
  const normalized = normalizePath(prefix);
  for (const root of [
    ...Object.values(PARTITIONED_RUNTIME_LEDGER_ROOTS),
    ...Object.values(PARTITIONED_RUNTIME_STATE_ROOTS),
  ]) {
    for (const tier of ['personal', 'confidential'] as const) {
      if (normalized === `${root}/${tier}`) return tier;
    }
  }
  return undefined;
}

/**
 * Does the current role hold an explicit `allow_read` grant that names a
 * partitioned ledger root (or a partition below it) and covers this path?
 * Only role grants naming the ledger itself count — a broad ancestor such as
 * `active/shared/` does not — so this admits exactly the governed ledger
 * reader roles declared in security-policy.json.
 */
function ledgerRoleReadGrant(
  policy: any,
  relativePath: string,
  identity: ReturnType<typeof resolvePolicyIdentityContext>
): boolean {
  if (!identity.role) return false;
  const patterns: unknown = policy.authority_role_permissions?.[identity.role]?.allow_read;
  if (!Array.isArray(patterns)) return false;
  const missionId = resolveProjectScope().missionId;
  return patterns.some((pattern) => {
    if (typeof pattern !== 'string') return false;
    const expanded = expandPolicyPath(pattern, missionId, identity.tenantSlug);
    if (expanded === null) return false;
    return (
      Object.values(PARTITIONED_RUNTIME_LEDGER_ROOTS).some((root) =>
        pathStartsWith(expanded, root)
      ) && pathStartsWith(relativePath, expanded)
    );
  });
}

/**
 * A role's `deny_read` carves paths out of its own read grants (e.g. a
 * tenant-knowledge reader that must never see the tenant's connection
 * secrets). It wins over every grant, SUDO included: the role is a
 * least-privilege assumption, so nothing reached through it may widen it.
 * Always evaluated on the real path being read (never a permission mirror),
 * case-insensitively and on its resolved spellings.
 */
function roleDenyReadDecision(
  policy: {
    authority_role_permissions?: Record<
      string,
      { deny_read?: unknown; deny_read_descendants?: unknown } | undefined
    >;
  },
  relativePath: string,
  identity: ReturnType<typeof resolvePolicyIdentityContext>
): { allowed: false; reason: string } | undefined {
  const currentRole = identity.role;
  if (!currentRole) return undefined;
  const currentMission = resolveProjectScope().missionId;
  const candidates = denyCandidatePaths(relativePath);
  const rules = policy.authority_role_permissions?.[currentRole];
  // A listing grant can admit the directory itself while denying every child.
  // Keep policy in the catalog and enforce all physical aliases, just as deny_read.
  const listingRoots = rules?.deny_read_descendants;
  if (
    Array.isArray(listingRoots) &&
    listingRoots.some((root) => {
      if (typeof root !== 'string') return false;
      const expanded = expandPolicyPath(root, currentMission, identity.tenantSlug);
      return (
        expanded !== null &&
        candidates.some((candidate) =>
          denyComparisonKey(candidate).startsWith(denyComparisonKey(expanded) + '/')
        )
      );
    })
  ) {
    return {
      allowed: false,
      reason: '[ROLE_VIOLATION] Directory listing permission does not allow reading descendants.',
    };
  }
  const deniedPatterns: unknown = rules?.deny_read;
  if (!Array.isArray(deniedPatterns) || deniedPatterns.length === 0) return undefined;
  if (
    deniedPatterns.some(
      (pattern) =>
        typeof pattern === 'string' &&
        denyPatternMatches(candidates, pattern, currentMission, identity.tenantSlug)
    )
  ) {
    return {
      allowed: false,
      reason: `[ROLE_VIOLATION] role '${currentRole}' may not read ${relativePath} — the path is carved out of its grants (security-policy.json authority_role_permissions.${currentRole}.deny_read) | read it under a role that owns it | role=${currentRole}`,
    };
  }
  return undefined;
}

/**
 * The persona/role/authority half of a protected-tier read decision (after the
 * tenant check): the role's deny_read carve-outs, SUDO scope, authority
 * grants, role grants, persona grants, project scope, then the tier
 * restriction. Partitioned runtime ledgers reuse it with their
 * `knowledge/<tier>` path, so their persona rules are exactly those of the
 * knowledge tier.
 */
function personaTierReadDecision(
  policy: any,
  relativePath: string,
  identity: ReturnType<typeof resolvePolicyIdentityContext>
): ReadPermissionDecision {
  const {
    persona: currentPersona,
    role: currentRole,
    authorities,
    sudoScope,
    tenantSlug,
  } = identity;
  const currentMission = resolveProjectScope().missionId;
  const roleDenial = roleDenyReadDecision(policy, relativePath, identity);
  if (roleDenial) return roleDenial;
  const projectTier = relativePath.match(
    /^active\/projects\/(personal|confidential|public)(?:\/|$)/
  )?.[1];
  const floorTier = storageFloorTier(relativePath);
  const organizationTier = relativePath.match(
    /^active\/organizations\/(personal|confidential|public)(?:\/|$)/
  )?.[1];
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
    return {
      allowed: false,
      reason: policy.tier_restrictions.personal.block_message,
      denialKind: 'tier_restriction',
    };
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
  const archiveMissionTier = relativePath.match(
    /^active\/archive\/missions\/(personal|confidential|public)(?:\/|$)/
  )?.[1];
  if (archiveMissionTier === 'personal') {
    return { allowed: false, reason: policy.tier_restrictions.personal.block_message };
  }
  if (archiveMissionTier === 'confidential') {
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
