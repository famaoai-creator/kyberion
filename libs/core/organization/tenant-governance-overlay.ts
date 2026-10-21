/**
 * Tenant governance overlays — tenant-owned additions to a product governance
 * catalog, read from `knowledge/confidential/<slug>/governance/<file>`.
 *
 * Product catalogs under `knowledge/product/governance/` are public tier, so a
 * real tenant slug must never be written there. A tenant declares its own
 * entries (event intake sources, standing mandates) in its confidential root
 * instead, and the owning loader merges them under its own rules.
 *
 * Same deny-by-default rule as tenant dot charters (`dot-charter.ts`): only
 * registered tenants, only their canonical `knowledge/confidential/<slug>`
 * root, a symlink-free regular file, read inside that tenant's bound runner
 * context. A file that cannot be read is reported for that tenant only; the
 * other tenants still load.
 */

import * as path from 'node:path';
import { withExecutionContext } from '../authority.js';
import { readJson } from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '../secure-io.js';
import { listTenantProfileSlugs, resolveTenant } from './tenant-registry.js';

/** Same tenant-bound runner role dot charters and chronos tenant pipelines use. */
const TENANT_OVERLAY_SCAN_ROLE = 'chronos_tenant_runner';
const OVERLAY_FILE_NAME = /^[a-z0-9][a-z0-9-]*\.json$/;

export interface TenantGovernanceOverlay {
  tenant_slug: string;
  /** Repo-relative overlay path. */
  path: string;
  /** Parsed JSON; absent when `error` is set. */
  value?: unknown;
  error?: string;
}

/** Repo-relative overlay path of one tenant. */
export function tenantGovernanceOverlayPath(slug: string, fileName: string): string {
  return `knowledge/confidential/${slug}/governance/${fileName}`;
}

/**
 * Every registered tenant's `governance/<fileName>` that exists (slug-sorted).
 * Tenants without the file are omitted; unreadable files carry `error`.
 */
export function readTenantGovernanceOverlays(
  fileName: string,
  options: { rootDir?: string } = {}
): TenantGovernanceOverlay[] {
  if (!OVERLAY_FILE_NAME.test(fileName)) {
    throw new Error(`invalid tenant governance overlay file name: ${fileName}`);
  }
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  // The repository path boundary resolves against an absolute root.
  const registryRoot = path.resolve(rootDir);
  let slugs: string[];
  try {
    slugs = withExecutionContext(TENANT_OVERLAY_SCAN_ROLE, () =>
      listTenantProfileSlugs({ rootDir: registryRoot })
    );
  } catch {
    return [];
  }
  const found: TenantGovernanceOverlay[] = [];
  for (const slug of [...slugs].sort()) {
    const relative = tenantGovernanceOverlayPath(slug, fileName);
    try {
      const value = withExecutionContext(
        TENANT_OVERLAY_SCAN_ROLE,
        (): { present: false } | { present: true; value: unknown } => {
          const filePath = path.join(rootDir, relative);
          if (!safeExistsSync(filePath)) return { present: false };
          const knowledgeRoot = resolveTenant(slug, { rootDir: registryRoot }).knowledge_root;
          if (knowledgeRoot !== `knowledge/confidential/${slug}`) return { present: false };
          assertSafeRepositoryPath(filePath, { rootDir: registryRoot, allowMissingLeaf: true });
          const stat = safeLstat(filePath);
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error('overlay must be a regular file, not a symlink');
          }
          return { present: true, value: readJson<unknown>(filePath) };
        },
        undefined,
        slug
      );
      if (value.present) found.push({ tenant_slug: slug, path: relative, value: value.value });
    } catch (error) {
      found.push({
        tenant_slug: slug,
        path: relative,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return found;
}
