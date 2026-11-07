import * as path from 'node:path';
import { resolvePolicyIdentityContext } from '../identity-context-bridge.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { assertSafeRepositoryPath, pathResolver } from '../path-resolver.js';

/**
 * Where a tenant's company assets live (S2 of the store-catalog guard design).
 *
 * The tenant owns them (custody `tenant`), so they sit inside the tenant's
 * confidential boundary, `knowledge/confidential/{tenant}/`, next to its other
 * knowledge — tenant scope protects reads and writes there. They used to live
 * in the top-level `customer/{tenant}/` directory, which tenant scope did not
 * cover; migration `0002-tenant-home` moves them.
 */
export const TENANT_HOME_ROOT = path.join('knowledge', 'confidential');

/** The company descriptor (display name, contacts, legacy financials). Was `customer.json`. */
export const TENANT_COMPANY_FILE = 'company.json';

/** The tenant's customer channel bindings (CD-11 / D8). */
export const TENANT_CHANNEL_BINDINGS_FILE = 'connections/channel-bindings.json';

/**
 * The tenant's customer records (deals with their documents, requirements,
 * escalations and notes), keyed by deal id. Deals name no customer yet; once
 * they do, they can move under `customers/{customer}/` (S3).
 */
export const TENANT_DEALS_DIR = 'deals';

/**
 * Company asset entries, relative to the tenant home. Everything else in the
 * legacy directory is either a stance (moved by 0001) or a customer record
 * (deals, moved in S3).
 */
export const TENANT_ASSET_ENTRIES = [
  TENANT_COMPANY_FILE,
  'vision.md',
  'organization-profile.json',
  'org-chart.json',
  'okr.json',
  'decision-rights.json',
  'finance',
  'brand',
  'design',
  TENANT_CHANNEL_BINDINGS_FILE,
] as const;

export function isTenantAssetEntry(relPath: string): boolean {
  const normalized = relPath.split(path.sep).join('/');
  return TENANT_ASSET_ENTRIES.some(
    (entry) => normalized === entry || normalized.startsWith(`${entry}/`)
  );
}

/** `knowledge/confidential/{tenant}/` for a valid tenant slug; throws otherwise. */
export function tenantHomeDir(
  tenantSlug: string,
  rootDir: string = pathResolver.rootDir()
): string {
  if (!isValidTenantSlug(tenantSlug)) {
    throw new Error(`[TENANT_HOME_SCOPE] invalid tenant slug: ${tenantSlug}`);
  }
  return assertSafeRepositoryPath(path.join(rootDir, TENANT_HOME_ROOT, tenantSlug), {
    allowMissingLeaf: true,
    rootDir,
  });
}

/** A path inside the tenant home; refuses a subPath that escapes it. */
export function tenantHomePath(
  tenantSlug: string,
  subPath: string,
  rootDir: string = pathResolver.rootDir()
): string {
  const home = tenantHomeDir(tenantSlug, rootDir);
  const target = path.resolve(home, subPath);
  if (target !== home && !target.startsWith(`${home}${path.sep}`)) {
    throw new Error(`[TENANT_HOME_SCOPE] path escapes the tenant home: ${subPath}`);
  }
  return assertSafeRepositoryPath(target, { allowMissingLeaf: true, rootDir });
}

/** The active tenant (execution scope, else `KYBERION_TENANT`), or null when none or invalid. */
export function activeTenantSlug(): string | null {
  const slug = resolvePolicyIdentityContext().tenantSlug?.trim();
  return slug && isValidTenantSlug(slug) ? slug : null;
}
