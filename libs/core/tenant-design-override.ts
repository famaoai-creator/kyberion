import * as path from 'node:path';
import { compileSchema } from './foundation/ajv.js';
import { readJson } from './foundation/json.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath } from './secure-io.js';

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

let validateOverride: ReturnType<typeof compileSchema<TenantDesignOverride>> | undefined;
let validateThemeOverlay: ReturnType<typeof compileSchema<TenantDesignThemeOverlay>> | undefined;

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
    const safePath = assertSafeRepositoryPath(filePath);
    validateOverride ||= compileSchema<TenantDesignOverride>(
      pathResolver.rootResolve('knowledge/product/schemas/tenant-design-override.schema.json')
    );
    const value = readJson<unknown>(safePath);
    if (!validateOverride(value)) return null;
    return value as TenantDesignOverride;
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
    const safePath = assertSafeRepositoryPath(filePath);
    validateThemeOverlay ||= compileSchema<TenantDesignThemeOverlay>(
      pathResolver.rootResolve('knowledge/product/schemas/tenant-design-theme-overlay.schema.json')
    );
    const value = readJson<unknown>(safePath);
    if (!validateThemeOverlay(value)) return null;
    return value as TenantDesignThemeOverlay;
  } catch {
    return null;
  }
}
