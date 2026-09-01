import * as path from 'node:path';
import { customerDirForSlug } from './customer-resolver.js';
import * as pathResolver from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { isRecord } from './foundation/text.js';
import { isValidTenantSlug } from './entity-scope.js';
import {
  safeExistsSync,
  safeMkdir,
  safeLstat,
  safeReadFile,
  safeReaddir,
  safeWriteFile,
  assertSafeRepositoryPath,
} from './secure-io.js';

const TENANT_GROUP_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const TENANT_GROUP_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/tenant-group.schema.json'
);
// Resolved at module load against the real repo root on purpose: the schema is
// tracked source, not fixture data — hermetic tests that pass a fixture
// rootDir still validate against the canonical schema.
const TENANT_PROFILE_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/tenant-profile.schema.json'
);

/** Declared ingest source system for a tenant (DA-01). */
export interface TenantIngestSource {
  source_system: string;
  enabled: boolean;
  note?: string;
}

export interface TenantProfile {
  tenant_slug: string;
  tenant_id?: string;
  display_name: string;
  status: 'active' | 'suspended' | 'archived';
  assigned_role: string;
  /** Tenant-level upper bound on providers allowed to receive its knowledge. */
  allowed_reasoning_backends?: string[];
  isolation_policy?: {
    strict_isolation?: boolean;
    allow_cross_distillation?: boolean;
  };
  /** Repo-relative tenant knowledge root. Defaults to knowledge/confidential/{tenant_slug}. */
  knowledge_root?: string;
  /** Ingest source systems declared for this tenant (DA-01). */
  ingest_sources?: TenantIngestSource[];
  metadata?: Record<string, unknown>;
}

/**
 * Path-resolution seam (DA-01): all defaults preserve the historical behavior
 * (real repo root + process.env); hermetic tests pass a fixture rootDir/env.
 */
export interface TenantRegistryPathOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** A tenant profile resolved to concrete filesystem roots (DA-01 spine). */
export interface ResolvedTenant {
  profile: TenantProfile;
  /** Repo-relative knowledge root, e.g. 'knowledge/confidential/tenant-masked-a'. */
  knowledge_root: string;
  /** Absolute path of knowledge_root. */
  knowledge_root_path: string;
  /** Absolute path of the customer/{slug}/ overlay directory, or null when absent on disk. */
  customer_overlay_root: string | null;
}

export interface TenantGroupProfile {
  tenant_group_id: string;
  display_name: string;
  status: 'active' | 'suspended' | 'archived';
  member_tenants: string[];
  shared_prefixes: string[];
  purpose?: string;
  metadata?: Record<string, unknown>;
}

function validateTenantProfile(
  profile: unknown,
  sourcePath = TENANT_PROFILE_SCHEMA_PATH
): TenantProfile {
  return defineCatalog<TenantProfile>({
    id: 'tenant-profile',
    path: sourcePath,
    schema: TENANT_PROFILE_SCHEMA_PATH,
  }).validate(profile, sourcePath);
}

function validateTenantGroupProfile(
  profile: TenantGroupProfile,
  sourcePath = TENANT_GROUP_SCHEMA_PATH
): TenantGroupProfile {
  return defineCatalog<TenantGroupProfile>({
    id: 'tenant-group-profile',
    path: sourcePath,
    schema: TENANT_GROUP_SCHEMA_PATH,
  }).validate(profile, sourcePath);
}

/** Status gate shared by every tenant-bound writer. */
export function assertTenantOperational(profile: TenantProfile, operation = 'operation'): void {
  if (profile.status !== 'active') {
    throw new Error(
      `[tenant-registry] tenant '${profile.tenant_slug}' is ${profile.status}; ${operation} requires an active tenant`
    );
  }
}

function assertTenantSlug(slug: string): void {
  if (!isValidTenantSlug(slug)) {
    throw new Error(`[tenant-registry] invalid tenant slug '${slug}'`);
  }
}

function assertTenantGroupId(groupId: string): void {
  if (!TENANT_GROUP_ID_RE.test(groupId)) {
    throw new Error(`[tenant-registry] invalid tenant group id '${groupId}'`);
  }
}

function assertTenantGroupProfile(profile: TenantGroupProfile): void {
  const groupId = profile.tenant_group_id;
  try {
    validateTenantGroupProfile(profile, tenantGroupPath(groupId));
  } catch (error) {
    throw new Error(`[tenant-registry] invalid tenant group profile '${groupId}': ${error}`);
  }
}

export function tenantProfileDir(options: TenantRegistryPathOptions = {}): string {
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  // The registry is durable authority, not a stance overlay. A customer stance
  // may contain a tenant facet for presentation, but changing
  // KYBERION_CUSTOMER must never change which tenant profile is authoritative.
  return path.join(rootDir, 'knowledge', 'personal', 'tenants');
}

export function tenantProfilePath(slug: string, options: TenantRegistryPathOptions = {}): string {
  assertTenantSlug(slug);
  return path.join(tenantProfileDir(options), `${slug}.json`);
}

/** Codepoint-sorted slugs of every tenant profile file in the profile directory. */
export function listTenantProfileSlugs(options: TenantRegistryPathOptions = {}): string[] {
  const dir = tenantProfileDir(options);
  let safeDir: string;
  try {
    safeDir = assertSafeRepositoryPath(dir, {
      allowMissingLeaf: true,
      rootDir: options.rootDir,
    });
  } catch {
    return [];
  }
  if (!safeExistsSync(safeDir)) return [];
  return safeReaddir(safeDir)
    .filter((entry) => entry.endsWith('.json'))
    .filter((entry) => {
      try {
        return safeLstat(path.join(safeDir, entry)).isFile();
      } catch {
        return false;
      }
    })
    .map((entry) => entry.slice(0, -'.json'.length))
    .filter(isValidTenantSlug)
    .sort();
}

function assertTenantProfile(profile: unknown): asserts profile is TenantProfile {
  const slug =
    isRecord(profile) && typeof profile.tenant_slug === 'string' ? profile.tenant_slug : 'unknown';
  try {
    validateTenantProfile(profile, `tenant profile '${slug}'`);
  } catch (error) {
    throw new Error(`[tenant-registry] invalid tenant profile '${slug}': ${error}`);
  }
}

/** Default repo-relative knowledge root for a tenant (DA-01). */
export function defaultTenantKnowledgeRoot(slug: string): string {
  assertTenantSlug(slug);
  return `knowledge/confidential/${slug}`;
}

/**
 * Resolve a profile-declared knowledge root without allowing cross-tenant
 * placement, traversal, or a symlinked component to change its identity.
 * The final leaf may be absent because resolveTenant is also used before
 * tenant knowledge is first created.
 */
function resolveTenantKnowledgeRootPath(
  rootDir: string,
  tenantSlug: string,
  knowledgeRoot: string
): string {
  const normalized = knowledgeRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const expectedPrefix = `knowledge/confidential/${tenantSlug}`;
  if (normalized !== expectedPrefix && !normalized.startsWith(`${expectedPrefix}/`)) {
    throw new Error(
      `[tenant-registry] tenant '${tenantSlug}' knowledge_root must remain under '${expectedPrefix}'`
    );
  }

  const base = path.resolve(rootDir);
  const absolute = path.resolve(base, normalized);
  const relative = path.relative(base, absolute).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(
      `[tenant-registry] tenant '${tenantSlug}' knowledge_root escapes registry root`
    );
  }

  try {
    return assertSafeRepositoryPath(absolute, { allowMissingLeaf: true, rootDir: base });
  } catch (error) {
    if (String((error as Error)?.message).includes('[RESOURCE_PATH_SYMLINK]')) {
      throw new Error(
        `[tenant-registry] tenant '${tenantSlug}' knowledge_root traverses a symbolic link`
      );
    }
    throw new Error(
      `[tenant-registry] tenant '${tenantSlug}' knowledge_root could not be inspected safely`
    );
  }
}

/** Underlying failure text, without its trailing period, so a suffix reads as one sentence. */
function describeCause(error: unknown): string {
  return String((error as Error)?.message ?? error).replace(/\s*\.\s*$/, '');
}

/**
 * Actionable suffix for a refused profile read. Keyed off where the profile
 * lives rather than the error text: personal-tier reads need an authorized
 * execution context, so that is the first thing to check.
 */
function profileReadHint(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  if (!normalized.includes('/knowledge/personal/')) return '';
  return (
    '. Personal-tier profiles require an authorized execution context — ' +
    'check KYBERION_PERSONA / MISSION_ROLE before suspecting the file itself'
  );
}

/**
 * Reads and schema-validates a tenant profile. Returns null when the profile
 * file does not exist; throws when it exists but cannot be read, is corrupt, or
 * is schema-invalid — each reported as its own failure so the cause is legible.
 */
export function readTenantProfile(
  slug: string,
  options: TenantRegistryPathOptions = {}
): TenantProfile | null {
  const file = tenantProfilePath(slug, options);
  let safeFile: string;
  try {
    safeFile = assertSafeRepositoryPath(file, {
      allowMissingLeaf: true,
      rootDir: options.rootDir,
    });
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    if (reason.includes('[RESOURCE_PATH_SYMLINK]')) {
      throw new Error(`[tenant-registry] tenant profile '${slug}' traverses a symbolic link`);
    }
    throw new Error(`[tenant-registry] tenant profile '${slug}' could not be inspected safely`);
  }
  if (!safeExistsSync(safeFile)) return null;
  // Read and parse are reported separately on purpose. Profiles normally live in
  // the personal tier, where secure-io denies unauthorized readers ("Sovereign
  // Sanctuary"); folding that denial into a "not valid JSON" message sent
  // callers looking for a corrupt file instead of a missing execution context.
  let source: string;
  try {
    source = safeReadFile(safeFile, { encoding: 'utf8' }) as string;
  } catch (error) {
    throw new Error(
      `[tenant-registry] tenant profile '${slug}' could not be read (${file}): ${describeCause(
        error
      )}${profileReadHint(file)}`
    );
  }
  let profile: unknown;
  try {
    profile = parseSafeJsonInput(source, `tenant profile '${slug}'`);
  } catch (error) {
    throw new Error(
      `[tenant-registry] tenant profile '${slug}' is not valid JSON (${file}): ${(error as Error).message}`
    );
  }
  assertTenantProfile(profile);
  if (profile.tenant_slug !== slug) {
    throw new Error(
      `[tenant-registry] tenant profile file '${file}' declares tenant_slug '${profile.tenant_slug}' (expected '${slug}')`
    );
  }
  return profile;
}

/**
 * Create or update a tenant profile through the same schema and path boundary
 * used by the registry reader. Callers that write personal-tier profiles must
 * establish a sovereign_concierge/sovereign execution context first.
 */
export function writeTenantProfile(
  profile: TenantProfile,
  options: TenantRegistryPathOptions = {}
): TenantProfile {
  assertTenantSlug(profile.tenant_slug);
  const normalized: TenantProfile = {
    ...profile,
    tenant_id: profile.tenant_id || profile.tenant_slug,
    knowledge_root: profile.knowledge_root || defaultTenantKnowledgeRoot(profile.tenant_slug),
  };
  assertTenantProfile(normalized);
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const knowledgeRootPath = resolveTenantKnowledgeRootPath(
    rootDir,
    normalized.tenant_slug,
    normalized.knowledge_root!
  );
  const file = tenantProfilePath(normalized.tenant_slug, options);
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8' });
  if (!safeExistsSync(knowledgeRootPath)) safeMkdir(knowledgeRootPath, { recursive: true });
  return normalized;
}

/**
 * DA-01 spine: resolves a tenant slug to its profile, knowledge root, and
 * customer overlay root — uniquely. Throws when the profile is missing so
 * callers cannot silently operate on an unregistered tenant.
 */
export function resolveTenant(
  slug: string,
  options: TenantRegistryPathOptions = {}
): ResolvedTenant {
  assertTenantSlug(slug);
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const profile = readTenantProfile(slug, options);
  if (!profile) {
    throw new Error(
      `[tenant-registry] tenant '${slug}' has no profile (expected ${tenantProfilePath(slug, options)}). ` +
        `Register it once in the tenant profile directory — see knowledge/product/governance/tenant-onboarding-procedure.md`
    );
  }
  assertTenantOperational(profile, 'tenant-bound operation');
  const knowledgeRoot = profile.knowledge_root ?? defaultTenantKnowledgeRoot(slug);
  const knowledgeRootPath = resolveTenantKnowledgeRootPath(rootDir, slug, knowledgeRoot);
  let safeOverlayDir: string | null = null;
  try {
    const overlayDir = customerDirForSlug(slug, rootDir);
    const candidate = assertSafeRepositoryPath(overlayDir, {
      allowMissingLeaf: true,
      rootDir,
    });
    if (safeExistsSync(candidate)) safeOverlayDir = candidate;
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    if (reason.includes('[RESOURCE_PATH_SYMLINK]')) {
      throw new Error(
        `[tenant-registry] tenant '${slug}' customer overlay traverses a symbolic link`
      );
    }
    throw new Error(
      `[tenant-registry] tenant '${slug}' customer overlay could not be inspected safely`
    );
  }
  return {
    profile,
    knowledge_root: knowledgeRoot,
    knowledge_root_path: knowledgeRootPath,
    customer_overlay_root: safeOverlayDir,
  };
}

export function tenantGroupDir(): string {
  return pathResolver.knowledge('confidential/tenant-groups');
}

export function tenantGroupPath(groupId: string): string {
  assertTenantGroupId(groupId);
  return path.join(tenantGroupDir(), `${groupId}.json`);
}

export function ensureDefaultTenantProfile(): TenantProfile {
  const file = tenantProfilePath('default');
  const existing = readTenantProfile('default');
  if (existing) return existing;

  const now = new Date().toISOString();
  const profile: TenantProfile = {
    tenant_slug: 'default',
    tenant_id: 'default',
    display_name: 'Default Tenant',
    status: 'active',
    assigned_role: 'owner',
    isolation_policy: {
      strict_isolation: true,
      allow_cross_distillation: false,
    },
    metadata: {
      bootstrap_source: 'tenant-registry.ensureDefaultTenantProfile',
      created_at: now,
    },
  };

  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(profile, null, 2) + '\n', { encoding: 'utf8' });
  return profile;
}

export function writeTenantGroupProfile(group: TenantGroupProfile): TenantGroupProfile {
  assertTenantGroupId(group.tenant_group_id);
  const normalizedMembers = Array.from(new Set(group.member_tenants));
  for (const tenant of normalizedMembers) assertTenantSlug(tenant);
  const normalizedPrefixes = Array.from(
    new Set(
      group.shared_prefixes.length > 0
        ? group.shared_prefixes
        : [`knowledge/confidential/shared/${group.tenant_group_id}/`]
    )
  );

  const normalized: TenantGroupProfile = {
    ...group,
    member_tenants: normalizedMembers,
    shared_prefixes: normalizedPrefixes,
  };
  assertTenantGroupProfile(normalized);

  const file = tenantGroupPath(group.tenant_group_id);
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8' });
  return normalized;
}
