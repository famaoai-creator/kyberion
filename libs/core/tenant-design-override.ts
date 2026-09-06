import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeLstat } from './secure-io.js';

export interface TenantDesignOverride {
  [key: string]: unknown;
  tenant_id?: string;
  brand_name?: string;
  matchers?: string[];
  design_system_id?: string;
  layout_template_id?: string;
  layout_template_catalog?: string;
  theme_pack_path?: string;
  theme?: string | Record<string, unknown>;
  branding?: Record<string, unknown>;
  extracted_theme?: Record<string, unknown>;
}

export interface TenantDesignThemeOverlay {
  [key: string]: unknown;
  brand_name?: string;
  tenant_slug?: string;
  theme?: Record<string, unknown>;
  layout_templates?: Record<string, unknown> | null;
  layout_template_catalog?: string | null;
  layout_template_id?: string;
}

const TENANT_DESIGN_OVERRIDE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/tenant-design-override.schema.json'
);
const TENANT_DESIGN_THEME_OVERLAY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/tenant-design-theme-overlay.schema.json'
);

function tenantDesignOverrideCatalog(filePath: string) {
  return defineCatalog<TenantDesignOverride>({
    id: 'tenant-design-override',
    path: filePath,
    schema: TENANT_DESIGN_OVERRIDE_SCHEMA_PATH,
  });
}

function tenantDesignThemeOverlayCatalog(filePath: string) {
  return defineCatalog<TenantDesignThemeOverlay>({
    id: 'tenant-design-theme-overlay',
    path: filePath,
    schema: TENANT_DESIGN_THEME_OVERLAY_SCHEMA_PATH,
  });
}

function isWithinRoot(filePath: string, rootDir: string): boolean {
  const relative = path.relative(path.resolve(rootDir), path.resolve(filePath));
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Load a tenant design override through one schema and secure path boundary. */
export function loadTenantDesignOverride(
  rootDir: string,
  filePath: string,
  allowedRootDir = rootDir
): TenantDesignOverride | null {
  if (!isWithinRoot(filePath, allowedRootDir)) return null;
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
    if (!safeLstat(safePath).isFile()) return null;
    return tenantDesignOverrideCatalog(safePath).load();
  } catch {
    return null;
  }
}

/** Load a partial tenant theme overlay through its dedicated schema boundary. */
export function loadTenantDesignThemeOverlay(
  rootDir: string,
  filePath: string,
  allowedRootDir = rootDir
): TenantDesignThemeOverlay | null {
  if (!isWithinRoot(filePath, allowedRootDir)) return null;
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
    if (!safeLstat(safePath).isFile()) return null;
    return tenantDesignThemeOverlayCatalog(safePath).load();
  } catch {
    return null;
  }
}
