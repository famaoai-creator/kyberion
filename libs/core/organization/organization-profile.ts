import * as path from 'node:path';
import { activeTenantSlug, tenantHomePath } from './tenant-home.js';
import { pathResolver } from '../path-resolver.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { createLogger } from '../logger.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReaddir } from '../secure-io.js';

const logger = createLogger('organization-profile');

/** File name of an organization profile. */
export const ORGANIZATION_PROFILE_FILE = 'organization-profile.json';

/**
 * Directory of a tenant's organizations inside its home (concept model v2 D3:
 * Tenant 1:N Organization). Each organization keeps its own profile at
 * `knowledge/confidential/{tenant}/organizations/{org}/organization-profile.json`
 * — the same `organizations/{org}` chain the scope context reads knowledge from.
 */
export const TENANT_ORGANIZATIONS_DIR = 'organizations';

const ORGANIZATION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const ORGANIZATION_PROFILE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-profile.schema.json'
);
const ORGANIZATION_PROFILE_PATH = pathResolver.knowledge(
  'product/governance/organization-profile.json'
);

export interface OrganizationProfileLlmOverride {
  description?: string;
  command?: string;
  args?: string[];
  timeout_ms?: number;
  response_format?: string;
  adapter?: string;
}

export interface OrganizationProfileWorkforce {
  mode?: string;
  accountable_owner_id?: string;
  accountable_human_resource_id?: string;
  default_approval_holder?: string;
  default_budget_posture?: string;
  resource_catalog_id?: string;
  default_resource_status?: 'active' | 'suspended' | 'revoked';
}

export interface OrganizationProfile {
  version: string;
  organization_id: string;
  name: string;
  description?: string;
  operating_principles?: string[];
  accountable_human_resource_id?: string;
  mission_defaults?: {
    default_mission_class?: string;
    default_team_template?: string;
    default_agent_profile?: string;
  };
  team_defaults?: {
    default_team_template?: string;
    team_template_catalog_id?: string;
    default_lifecycle_template?: string;
    max_parallel_missions?: number;
  };
  workforce?: OrganizationProfileWorkforce;
  llm?: {
    purpose_map?: Record<string, string>;
    default_profile?: string;
    profile_overrides?: Record<string, OrganizationProfileLlmOverride>;
  };
}

function loadOrganizationProfileCatalog(filePath: string): OrganizationProfile {
  return defineCatalog<OrganizationProfile>({
    id: 'organization-profile',
    path: filePath,
    schema: ORGANIZATION_PROFILE_SCHEMA_PATH,
  }).load();
}

/** Load a known organization-profile path through the canonical schema boundary. */
export function loadOrganizationProfileAtPath(filePath: string): OrganizationProfile {
  return loadOrganizationProfileCatalog(assertSafeRepositoryPath(filePath));
}

function assertOrganizationId(organizationId: string): string {
  const id = organizationId.trim();
  if (!ORGANIZATION_ID_PATTERN.test(id) || id === '.' || id === '..') {
    throw new Error(`[ORGANIZATION_PROFILE_SCOPE] invalid organization id: ${organizationId}`);
  }
  return id;
}

/** `knowledge/confidential/{tenant}/organizations/{org}/organization-profile.json`. */
export function organizationProfilePath(
  tenantSlug: string,
  organizationId: string,
  rootDir?: string
): string {
  return tenantHomePath(
    tenantSlug,
    path.join(
      TENANT_ORGANIZATIONS_DIR,
      assertOrganizationId(organizationId),
      ORGANIZATION_PROFILE_FILE
    ),
    rootDir
  );
}

/**
 * The pre-D3 location, one profile per tenant at the tenant-home root
 * (`knowledge/confidential/{tenant}/organization-profile.json`). Read as a
 * fallback for one release; new profiles are written per organization.
 */
export function legacyOrganizationProfilePath(tenantSlug: string, rootDir?: string): string {
  return tenantHomePath(tenantSlug, ORGANIZATION_PROFILE_FILE, rootDir);
}

/** Organizations of a tenant that have a per-organization profile, sorted. */
export function listTenantOrganizationProfileIds(tenantSlug: string, rootDir?: string): string[] {
  const dir = tenantHomePath(tenantSlug, TENANT_ORGANIZATIONS_DIR, rootDir);
  if (!safeExistsSync(dir) || !safeLstat(dir).isDirectory()) return [];
  return safeReaddir(dir)
    .filter((entry) => ORGANIZATION_ID_PATTERN.test(entry))
    .filter((entry) => {
      const file = path.join(dir, entry, ORGANIZATION_PROFILE_FILE);
      return safeExistsSync(file) && safeLstat(file).isFile();
    })
    .sort();
}

const warnedLegacyProfilePaths = new Set<string>();

function warnLegacyProfileOnce(legacyPath: string, tenantSlug: string): void {
  if (warnedLegacyProfilePaths.has(legacyPath)) return;
  warnedLegacyProfilePaths.add(legacyPath);
  logger.warn(
    `organization profile read from the legacy tenant-root location ${legacyPath} — ` +
      `profiles are per organization now (concept model v2 D3) | next: pnpm migration ` +
      `(0004-organization-profile-home) moves it to knowledge/confidential/${tenantSlug}/` +
      `${TENANT_ORGANIZATIONS_DIR}/<org>/${ORGANIZATION_PROFILE_FILE}; the fallback is read for one release`
  );
}

/**
 * Where a tenant's organization profile is read from. The organization is
 * `organizationId`, else the active organization (`KYBERION_ORGANIZATION_ID`),
 * else the tenant's only organization with a profile. Its per-organization
 * profile wins; otherwise the legacy tenant-root profile is used (with a
 * one-time deprecation warning) for one release. `null` when neither exists.
 */
export function resolveTenantOrganizationProfilePath(
  tenantSlug: string,
  organizationId?: string | null,
  rootDir?: string
): { path: string; organizationId: string | null; legacy: boolean } | null {
  const requested =
    organizationId?.trim() || getRegisteredEnvText('KYBERION_ORGANIZATION_ID')?.trim() || '';
  let selected: string | null = null;
  if (requested && ORGANIZATION_ID_PATTERN.test(requested)) selected = requested;
  else {
    const ids = listTenantOrganizationProfileIds(tenantSlug, rootDir);
    if (ids.length === 1) selected = ids[0];
  }
  if (selected) {
    const perOrg = organizationProfilePath(tenantSlug, selected, rootDir);
    if (safeExistsSync(perOrg)) return { path: perOrg, organizationId: selected, legacy: false };
  }
  const legacy = legacyOrganizationProfilePath(tenantSlug, rootDir);
  if (safeExistsSync(legacy)) {
    warnLegacyProfileOnce(legacy, tenantSlug);
    return { path: legacy, organizationId: null, legacy: true };
  }
  return null;
}

/** Test-only: forget which legacy profile paths already warned. */
export function resetLegacyOrganizationProfileWarningsForTests(): void {
  warnedLegacyProfilePaths.clear();
}

/**
 * The organization profile of a tenant's organization (a company asset; see
 * {@link resolveTenantOrganizationProfilePath}), else the product default. The
 * tenant is `tenantSlug`, else the active tenant (`KYBERION_TENANT`); the
 * stance never selects it.
 */
export function loadOrganizationProfile(
  rootDir?: string,
  tenantSlug: string | null = activeTenantSlug(),
  organizationId?: string | null
): OrganizationProfile | null {
  let tenantProfilePath: string | null = null;
  if (tenantSlug) {
    try {
      tenantProfilePath =
        resolveTenantOrganizationProfilePath(tenantSlug, organizationId, rootDir)?.path ?? null;
    } catch {
      tenantProfilePath = null;
    }
  }
  const candidatePaths = [
    tenantProfilePath,
    rootDir
      ? assertSafeRepositoryPath(
          path.join(rootDir, 'knowledge', 'public', 'governance', 'organization-profile.json'),
          { allowMissingLeaf: true, rootDir }
        )
      : null,
    rootDir ? null : ORGANIZATION_PROFILE_PATH,
  ].filter((entry): entry is string => Boolean(entry));

  for (const profilePath of candidatePaths) {
    let safeProfilePath: string;
    try {
      safeProfilePath = assertSafeRepositoryPath(profilePath, { allowMissingLeaf: true, rootDir });
    } catch {
      continue;
    }
    if (!safeExistsSync(safeProfilePath)) continue;
    try {
      return loadOrganizationProfileCatalog(safeProfilePath);
    } catch {
      // try next candidate
    }
  }
  return null;
}
