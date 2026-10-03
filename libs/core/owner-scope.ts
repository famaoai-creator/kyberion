/**
 * Owner-derived scope — one resolver for "which tier / tenant / organization
 * does this owner live in".
 *
 * Writes that belong to an owner (a mission, project or organization) must be
 * placed by the owner's own record, never by a caller's guess: a caller-supplied
 * tier or tenant may only narrow (equal) the owner's scope, and a contradiction
 * is an error with a structured remedy. See
 * knowledge/product/architecture/runtime-storage-layout.md (§2 owner scope).
 *
 * Lookup is independent of `KYBERION_TENANT` (a tenant mission is found whether
 * or not the process is tenant-bound), but visibility is not: an identity bound
 * to tenant T never resolves another tenant's owner — that reads as not found,
 * so nothing about the other tenant is disclosed.
 */
import * as path from 'node:path';
import { currentExecutionScope } from './foundation/execution-scope.js';
import { resolveProjectScope } from './foundation/project-scope-env.js';
import { isReservedScopeName, isValidTenantSlug } from './foundation/scope.js';
import * as pathResolver from './path-resolver.js';
import { safeExistsSync, safeLstat, safeReaddir } from './secure-io.js';
import { loadMissionStateAtPath } from './mission/mission-state-reader.js';
import { loadProjectRecord } from './project/project-registry.js';

export type OwnerTier = 'personal' | 'confidential' | 'public';

const OWNER_TIERS: readonly OwnerTier[] = ['personal', 'confidential', 'public'];

/** Tenant segment for owners bound to no tenant. */
export const SHARED_TENANT = 'shared';

export type OwnerRef =
  | { kind: 'mission'; id: string }
  | { kind: 'project'; id: string }
  | { kind: 'organization'; id: string };

/** Caller-known scope. It may only narrow the owner's scope, never override it. */
export interface OwnerScopeHint {
  tier?: OwnerTier;
  /** Tenant slug, or `shared` for an untenanted owner. */
  tenant?: string;
}

export interface OwnerScope {
  owner: OwnerRef;
  tier: OwnerTier;
  /** Tenant slug, or `shared`. */
  tenant: string;
  organization_id?: string;
  project_id?: string;
  /** Absolute directory of the owner (mission dir, project workspace, organization workspace). */
  dir: string;
}

export type OwnerScopeErrorCode =
  'OWNER_ID_INVALID' | 'OWNER_NOT_FOUND' | 'OWNER_AMBIGUOUS' | 'SCOPE_CONTRADICTS_OWNER';

/**
 * A scope failure that says what was expected and how to fix it, so a person
 * or an agent can act on it without reading code. Message:
 * `[CODE] what — why | next: remedy`.
 */
export class OwnerScopeError extends Error {
  readonly code: OwnerScopeErrorCode;
  readonly owner: OwnerRef;
  readonly expected?: Partial<Pick<OwnerScope, 'tier' | 'tenant'>>;
  readonly actual?: OwnerScopeHint;
  readonly remedy: string;

  constructor(input: {
    code: OwnerScopeErrorCode;
    owner: OwnerRef;
    what: string;
    why: string;
    remedy: string;
    expected?: Partial<Pick<OwnerScope, 'tier' | 'tenant'>>;
    actual?: OwnerScopeHint;
  }) {
    super(`[${input.code}] ${input.what} — ${input.why} | next: ${input.remedy}`);
    this.name = 'OwnerScopeError';
    this.code = input.code;
    this.owner = input.owner;
    this.expected = input.expected;
    this.actual = input.actual;
    this.remedy = input.remedy;
  }
}

const OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function ownerLabel(owner: OwnerRef): string {
  return `${owner.kind} ${owner.id}`;
}

function assertOwnerId(owner: OwnerRef): void {
  if (!OWNER_ID_PATTERN.test(owner.id) || /^\.+$/u.test(owner.id)) {
    throw new OwnerScopeError({
      code: 'OWNER_ID_INVALID',
      owner,
      what: `invalid ${owner.kind} id ${JSON.stringify(owner.id)}`,
      why: 'owner ids are single path segments of letters, digits, ".", "_" or "-"',
      remedy: `pass the ${owner.kind} id exactly as registered`,
    });
  }
}

/**
 * Tenant value as recorded or hinted: a valid slug, else untenanted (`shared`).
 * Empty, reserved names and the legacy `default` sentinel (positional
 * `tenantId` / untenanted context packs) are untenanted, never a tenant.
 */
function normalizeTenant(value: unknown): string {
  const tenant = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!tenant || tenant === SHARED_TENANT || tenant === 'default' || isReservedScopeName(tenant)) {
    return SHARED_TENANT;
  }
  return isValidTenantSlug(tenant) ? tenant : SHARED_TENANT;
}

/**
 * Tenant recorded in a mission state. Unlike a hint, a non-empty value that is
 * neither untenanted nor a valid slug is unknown (null), never `shared`: a
 * malformed record must not become visible to every tenant.
 */
function normalizeStateTenant(value: unknown): string | null {
  const tenant = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!tenant || tenant === SHARED_TENANT || tenant === 'default' || isReservedScopeName(tenant)) {
    return SHARED_TENANT;
  }
  return isValidTenantSlug(tenant) ? tenant : null;
}

/** A directory under a tier root is a tenant partition only if its name is a tenant slug. */
function isTenantDirectoryName(name: string): boolean {
  return name === SHARED_TENANT || (isValidTenantSlug(name) && !isReservedScopeName(name));
}

/**
 * Tenant the current identity is bound to: the execution scope first (e.g. a
 * surface request), then the process scope (`KYBERION_TENANT`) — the same
 * order identity resolution (authority.ts) uses.
 */
function boundTenant(): string | undefined {
  const executionScope = currentExecutionScope();
  const value = String(
    (executionScope?.tenantBound ? executionScope.tenantSlug : resolveProjectScope().tenantSlug) ||
      ''
  )
    .trim()
    .toLowerCase();
  return isValidTenantSlug(value) ? value : undefined;
}

function visibleToProcess(tenant: string): boolean {
  const bound = boundTenant();
  return !bound || tenant === SHARED_TENANT || tenant === bound;
}

function isDirectory(candidate: string): boolean {
  try {
    return safeExistsSync(candidate) && safeLstat(candidate).isDirectory();
  } catch {
    // An unreadable tier (role without a grant) is simply not searched.
    return false;
  }
}

function childDirectories(directory: string): string[] {
  if (!isDirectory(directory)) return [];
  try {
    return safeReaddir(directory).filter((entry) => isDirectory(path.join(directory, entry)));
  } catch {
    return [];
  }
}

function applyHint(scope: OwnerScope, hint: OwnerScopeHint | undefined): OwnerScope {
  if (!hint) return scope;
  const hintTenant = hint.tenant === undefined ? undefined : normalizeTenant(hint.tenant);
  const tierMismatch = hint.tier !== undefined && hint.tier !== scope.tier;
  const tenantMismatch = hintTenant !== undefined && hintTenant !== scope.tenant;
  if (!tierMismatch && !tenantMismatch) return scope;
  throw new OwnerScopeError({
    code: 'SCOPE_CONTRADICTS_OWNER',
    owner: scope.owner,
    what: `${ownerLabel(scope.owner)} is ${scope.tier}/${scope.tenant}, not ${hint.tier ?? scope.tier}/${hintTenant ?? scope.tenant}`,
    why: "an owned write is placed by the owner's own record; a caller value may only narrow it",
    remedy: `drop the explicit tier/tenant or pass tier '${scope.tier}' and tenant '${scope.tenant}'`,
    expected: { tier: scope.tier, tenant: scope.tenant },
    actual: { tier: hint.tier, tenant: hintTenant },
  });
}

function notFound(owner: OwnerRef, remedy: string): OwnerScopeError {
  return new OwnerScopeError({
    code: 'OWNER_NOT_FOUND',
    owner,
    what: `${ownerLabel(owner)} not found`,
    why: 'no record for it is visible to this process',
    remedy,
  });
}

function ambiguous(owner: OwnerRef, matches: string[]): OwnerScopeError {
  return new OwnerScopeError({
    code: 'OWNER_AMBIGUOUS',
    owner,
    what: `${ownerLabel(owner)} exists in ${matches.length} scopes (${matches.join(', ')})`,
    why: `${owner.kind} ids are unique only within a tier/tenant`,
    remedy: 'pass the tier and tenant explicitly to select one',
  });
}

// --- mission -----------------------------------------------------------------

interface MissionCandidate {
  dir: string;
  tier: OwnerTier;
  dirTenant: string;
}

function missionCandidates(missionId: string): MissionCandidate[] {
  const found: MissionCandidate[] = [];
  const seen = new Set<string>();
  for (const tier of OWNER_TIERS) {
    // missionDir() applies the configured tier root (mission-management-config).
    const tierRoot = path.dirname(pathResolver.missionDir(missionId, tier));
    const consider = (dir: string, dirTenant: string) => {
      if (seen.has(dir)) return;
      if (safeExistsSync(path.join(dir, 'mission-state.json'))) {
        seen.add(dir);
        found.push({ dir, tier, dirTenant });
      }
    };
    try {
      consider(path.join(tierRoot, missionId), SHARED_TENANT);
      if (!isDirectory(tierRoot)) continue;
      // Only tenant-slug names are tenant partitions: mission ids (uppercase)
      // are skipped by name, without a stat per mission directory.
      for (const entry of safeReaddir(tierRoot)) {
        if (entry === missionId || !isTenantDirectoryName(entry)) continue;
        consider(path.join(tierRoot, entry, missionId), normalizeTenant(entry));
      }
    } catch {
      // An unreadable tier root is not searched.
    }
  }
  return found;
}

/** Where a mission sits, read from disk; visibility and hints are applied per call. */
interface MissionLocation {
  dir: string;
  /** mtime of mission-state.json when read; a rewrite invalidates the memo. */
  stateMtimeMs: number;
  tier: OwnerTier;
  /** null when the tenant cannot be established (unreadable state outside a tenant dir). */
  tenant: string | null;
  organization_id?: string;
  project_id?: string;
}

/**
 * The tenant directory a mission sits in is authoritative; the state's tenant
 * must agree with it. A flat (untenanted-dir) mission takes the state's tenant,
 * and an unreadable state there leaves the tenant unknown — never `shared`.
 */
function locateMission(candidate: MissionCandidate): MissionLocation | undefined {
  const state = loadMissionStateAtPath(path.join(candidate.dir, 'mission-state.json'));
  // undefined: no readable state; null: a recorded tenant that is not a slug.
  const stateTenant = state
    ? normalizeStateTenant(state.tenant_slug || state.tenant_id || SHARED_TENANT)
    : undefined;
  let tenant: string | null;
  if (candidate.dirTenant !== SHARED_TENANT) {
    if (stateTenant && stateTenant !== SHARED_TENANT && stateTenant !== candidate.dirTenant) {
      // A state naming another tenant than its directory is inconsistent:
      // never resolve it into either tenant.
      return undefined;
    }
    tenant = candidate.dirTenant;
  } else {
    tenant = stateTenant === undefined ? null : stateTenant;
  }
  const tier = OWNER_TIERS.includes(state?.tier as OwnerTier)
    ? (state?.tier as OwnerTier)
    : candidate.tier;
  const organizationId =
    state?.organization_id || state?.relationships?.organization?.organization_id;
  const projectId = state?.relationships?.project?.project_id;
  return {
    dir: candidate.dir,
    stateMtimeMs: stateMtime(candidate.dir),
    tier,
    tenant,
    ...(organizationId ? { organization_id: organizationId } : {}),
    ...(projectId ? { project_id: projectId } : {}),
  };
}

/**
 * Per-process memo of mission locations. Hot paths (task events, the
 * coordination bus, dispatch loops) resolve the same mission many times; a
 * short-lived entry whose directories still hold their state skips the scan.
 * Visibility and hints are applied per call (the bound tenant can change per
 * execution scope), never cached.
 */
const MISSION_LOCATION_TTL_MS = 2_000;

function stateMtime(dir: string): number {
  try {
    return safeLstat(path.join(dir, 'mission-state.json')).mtimeMs;
  } catch {
    return -1;
  }
}
const missionLocationCache = new Map<string, { at: number; locations: MissionLocation[] }>();

function missionLocations(missionId: string): MissionLocation[] {
  const cached = missionLocationCache.get(missionId);
  if (
    cached &&
    Date.now() - cached.at < MISSION_LOCATION_TTL_MS &&
    cached.locations.every((location) => stateMtime(location.dir) === location.stateMtimeMs)
  ) {
    return cached.locations;
  }
  const locations = missionCandidates(missionId)
    .map(locateMission)
    .filter((location): location is MissionLocation => Boolean(location));
  // Never memoize "not found": a mission created right after must resolve.
  if (locations.length > 0) {
    missionLocationCache.set(missionId, { at: Date.now(), locations });
  } else {
    missionLocationCache.delete(missionId);
  }
  return locations;
}

/** Drop memoized mission locations (tests, or after moving a mission). */
export function clearOwnerScopeCache(): void {
  missionLocationCache.clear();
}

function resolveMission(owner: OwnerRef, hint?: OwnerScopeHint): OwnerScope {
  const bound = boundTenant();
  const scopes: OwnerScope[] = [];
  for (const location of missionLocations(owner.id)) {
    // A tenant that cannot be established is visible only to an unbound
    // identity, and then as untenanted: a bound identity fails closed.
    if (location.tenant === null && bound) continue;
    const tenant = location.tenant ?? SHARED_TENANT;
    if (!visibleToProcess(tenant)) continue;
    scopes.push({
      owner,
      tier: location.tier,
      tenant,
      ...(location.organization_id ? { organization_id: location.organization_id } : {}),
      ...(location.project_id ? { project_id: location.project_id } : {}),
      dir: location.dir,
    });
  }
  return pickOne(owner, scopes, hint, 'start the mission first or check the mission id');
}

// --- project -----------------------------------------------------------------

function resolveProject(owner: OwnerRef, hint?: OwnerScopeHint): OwnerScope {
  const record = loadProjectRecord(owner.id);
  const tenant = normalizeTenant(record?.tenant_slug);
  if (!record || !visibleToProcess(tenant)) {
    throw notFound(owner, 'create it with `pnpm project create` or check the project id');
  }
  if (!OWNER_TIERS.includes(record.tier as OwnerTier)) {
    throw notFound(owner, `fix the project record's tier ('${String(record.tier)}')`);
  }
  const tier = record.tier as OwnerTier;
  return applyHint(
    {
      owner,
      tier,
      tenant,
      project_id: record.project_id,
      ...(record.organization_id ? { organization_id: record.organization_id } : {}),
      dir: pathResolver.projectWorkspaceDir(record.project_id, tier, tenant),
    },
    hint
  );
}

// --- organization ------------------------------------------------------------

function resolveOrganization(owner: OwnerRef, hint?: OwnerScopeHint): OwnerScope {
  const scopes: OwnerScope[] = [];
  const tiers = hint?.tier ? [hint.tier] : OWNER_TIERS;
  for (const tier of tiers) {
    const tierRoot = path.join(pathResolver.rootDir(), 'active', 'organizations', tier);
    const tenants =
      hint?.tenant !== undefined
        ? [normalizeTenant(hint.tenant)]
        : childDirectories(tierRoot).filter(isTenantDirectoryName);
    for (const tenantDir of tenants) {
      const tenant = normalizeTenant(tenantDir);
      if (!visibleToProcess(tenant)) continue;
      let stateDir: string;
      try {
        stateDir = pathResolver.organizationStateDir(owner.id, tier, tenant);
      } catch {
        continue;
      }
      if (!isDirectory(stateDir)) continue;
      scopes.push({
        owner,
        tier,
        tenant,
        organization_id: owner.id,
        dir: pathResolver.organizationWorkspaceDir(owner.id, tier, tenant),
      });
    }
  }
  return pickOne(
    owner,
    scopes,
    hint,
    'initialize it with `pnpm organization init` or check the id'
  );
}

function pickOne(
  owner: OwnerRef,
  scopes: OwnerScope[],
  hint: OwnerScopeHint | undefined,
  notFoundRemedy: string
): OwnerScope {
  if (scopes.length === 0) throw notFound(owner, notFoundRemedy);
  if (scopes.length > 1) {
    // A hint may select among same-id owners in different scopes; it is still
    // only a selector: exactly one owner must match it.
    const hintTenant = hint?.tenant === undefined ? undefined : normalizeTenant(hint.tenant);
    const selected = scopes.filter(
      (scope) =>
        (hint?.tier === undefined || scope.tier === hint.tier) &&
        (hintTenant === undefined || scope.tenant === hintTenant)
    );
    if (selected.length === 1) return selected[0];
    throw ambiguous(
      owner,
      scopes.map((scope) => `${scope.tier}/${scope.tenant}`)
    );
  }
  return applyHint(scopes[0], hint);
}

/**
 * Resolve an owner's scope from its own record. `hint` (caller-known tier /
 * tenant) only narrows: it may select among same-id owners, and it must agree
 * with the owner it resolves to.
 */
export function resolveOwnerScope(owner: OwnerRef, hint?: OwnerScopeHint): OwnerScope {
  assertOwnerId(owner);
  switch (owner.kind) {
    case 'mission':
      return resolveMission({ kind: 'mission', id: owner.id.toUpperCase() }, hint);
    case 'project':
      return resolveProject(owner, hint);
    case 'organization':
      return resolveOrganization(owner, hint);
    default:
      throw new Error(`resolveOwnerScope: unsupported owner kind ${(owner as OwnerRef).kind}`);
  }
}

/**
 * For read paths: the owner's scope, or null when it cannot be determined
 * (not found, or the id is ambiguous across scopes). A contradicting hint and
 * an invalid id still throw. Writes use resolveOwnerScope / resolveMissionDir,
 * which fail closed on every case.
 */
export function tryResolveOwnerScope(owner: OwnerRef, hint?: OwnerScopeHint): OwnerScope | null {
  try {
    return resolveOwnerScope(owner, hint);
  } catch (error) {
    if (
      error instanceof OwnerScopeError &&
      (error.code === 'OWNER_NOT_FOUND' || error.code === 'OWNER_AMBIGUOUS')
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Directory of an existing mission, derived from where it actually lives.
 * Replaces `findMissionPath(id) ?? missionDir(id, <guessed tier>)`: a caller's
 * tier/tenant is only a hint that must agree with the mission.
 */
export function resolveMissionDir(missionId: string, hint?: OwnerScopeHint): string {
  return resolveOwnerScope({ kind: 'mission', id: missionId }, hint).dir;
}

/**
 * Existing missions are found from their own record everywhere a mission
 * directory is looked up (path-resolver's findMissionPath sits below this
 * module, so it reaches the resolver through this registration).
 */
function locateMissionDir(missionId: string): string | undefined {
  try {
    return resolveOwnerScope({ kind: 'mission', id: missionId }).dir;
  } catch (error) {
    if (error instanceof OwnerScopeError && error.code === 'OWNER_NOT_FOUND') return undefined;
    throw error;
  }
}

try {
  pathResolver.registerMissionLocator(locateMissionDir);
} catch {
  // A test double of path-resolver without the registration hook also stubs
  // findMissionPath, so there is nothing to back.
}
