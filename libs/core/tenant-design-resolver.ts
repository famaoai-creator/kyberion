import * as path from 'node:path';
import { customerRoot } from './customer-resolver.js';
import {
  loadJsonIfPresent as loadOptionalJson,
  safeExistsSync,
  safeLstat,
  safeReaddir,
  safeStat,
} from './secure-io.js';

export interface ResolveTenantDesignInput {
  rootDir?: string;
  customerId?: string;
  brandName?: string;
  designSystemId?: string;
}

export interface TenantDesignResolution {
  source: 'tenant' | 'default';
  tokens: Record<string, string>;
  layoutCatalog?: string | null;
  logoPath?: string | null;
  tenantOverride?: Record<string, unknown> | null;
  themePack?: Record<string, unknown> | null;
  matchedPath?: string | null;
}

interface TenantEntry {
  id?: string;
  override_path: string;
}

function isSafeTenantSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

function isSafeTenantDesignPath(
  filePath: string,
  rootDir: string,
  requireFile = true,
  allowedRootDir = rootDir
): boolean {
  const root = path.resolve(rootDir);
  if (!safeExistsSync(root)) return false;
  try {
    if (safeLstat(root).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  const absolute = path.resolve(filePath);
  const boundary = path.resolve(allowedRootDir);
  if (!safeExistsSync(boundary)) return false;
  try {
    if (safeLstat(boundary).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  const relative = path.relative(boundary, absolute);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return false;
  }

  let current = boundary;
  const segments = relative.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    if (!safeExistsSync(current)) {
      if (index === segments.length - 1 && !requireFile) return true;
      return false;
    }
    try {
      const stat = safeLstat(current);
      if (
        stat.isSymbolicLink() ||
        (index === segments.length - 1 && (requireFile ? !stat.isFile() : stat.isDirectory()))
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function readJsonIfPresent(
  filePath: string,
  rootDir: string,
  allowedRootDir = rootDir
): Record<string, any> | null {
  if (!isSafeTenantDesignPath(filePath, rootDir, true, allowedRootDir)) return null;
  return loadOptionalJson<Record<string, any>>(filePath);
}

function isConfidentialTenantDesignPath(
  filePath: string,
  rootDir: string,
  tenantId: unknown
): boolean {
  if (!isSafeTenantSegment(tenantId)) return false;
  const designRoot = path.join(rootDir, 'knowledge', 'confidential', tenantId, 'design');
  return isSafeTenantDesignPath(filePath, rootDir, true, designRoot);
}

function collectTenantOverridePaths(rootDir: string, customerId?: string): string[] {
  const candidates = new Set<string>();

  if (customerId) {
    const customerPath = customerRoot(
      path.join('design', 'tenant-override.json'),
      {
        ...process.env,
        KYBERION_CUSTOMER: customerId,
      },
      rootDir
    );
    if (customerPath && safeExistsSync(customerPath)) {
      return [path.resolve(customerPath)];
    }
  }

  const indexPath = path.join(rootDir, 'knowledge/confidential/tenants/index.json');
  const registry = readJsonIfPresent(indexPath, rootDir);
  if (Array.isArray(registry?.tenants)) {
    for (const entry of registry.tenants as TenantEntry[]) {
      if (entry?.override_path) {
        const candidate = path.resolve(rootDir, entry.override_path);
        if (
          (!customerId || entry.id === customerId) &&
          isConfidentialTenantDesignPath(candidate, rootDir, entry.id)
        ) {
          candidates.add(candidate);
        }
      }
    }
  }

  const confidentialDir = path.join(rootDir, 'knowledge', 'confidential');
  if (safeExistsSync(confidentialDir)) {
    const tenantDirs = customerId
      ? isSafeTenantSegment(customerId)
        ? [customerId]
        : []
      : safeReaddir(confidentialDir);
    for (const entry of tenantDirs) {
      try {
        const tenantDir = path.join(confidentialDir, entry);
        if (!safeStat(tenantDir).isDirectory()) continue;
        const candidate = path.join(tenantDir, 'design', 'tenant-override.json');
        if (isConfidentialTenantDesignPath(candidate, rootDir, entry)) {
          candidates.add(candidate);
        }
      } catch {
        // ignore unreadable entries
      }
    }
  }

  return [...candidates];
}

function matchesOverride(
  override: Record<string, any>,
  brandName?: string,
  designSystemId?: string
): boolean {
  if (designSystemId && override.design_system_id && override.design_system_id !== designSystemId) {
    return false;
  }
  if (!brandName) return false;
  const key = brandName.toLowerCase();
  if (
    Array.isArray(override.matchers) &&
    override.matchers.some((m: string) => key.includes(String(m).toLowerCase()))
  ) {
    return true;
  }
  const brandingName = String(
    override.branding?.brand_name || override.brand_name || ''
  ).toLowerCase();
  return brandingName !== '' && (key.includes(brandingName) || brandingName.includes(key));
}

function deriveThemePackPath(overridePath: string, override: Record<string, any>): string | null {
  if (typeof override.theme_pack_path === 'string' && override.theme_pack_path.trim()) {
    return override.theme_pack_path.trim();
  }
  if (overridePath.includes('/design/tenant-override.json')) {
    return overridePath.replace(/\/design\/tenant-override\.json$/, '/design/theme.json');
  }
  return null;
}

function deriveLayoutCatalogPath(
  overridePath: string,
  override: Record<string, any>,
  themePack?: Record<string, any> | null
): string | null {
  if (
    typeof override.layout_template_catalog === 'string' &&
    override.layout_template_catalog.trim()
  ) {
    return override.layout_template_catalog.trim();
  }
  if (
    typeof themePack?.layout_template_catalog === 'string' &&
    themePack.layout_template_catalog.trim()
  ) {
    return themePack.layout_template_catalog.trim();
  }
  if (overridePath.includes('/design/tenant-override.json')) {
    return overridePath.replace(
      /\/design\/tenant-override\.json$/,
      '/design/layout-templates.json'
    );
  }
  return null;
}

function buildTokens(
  override: Record<string, any>,
  themePack: Record<string, any> | null
): Record<string, string> {
  const colors = themePack?.theme?.colors || {};
  const fonts = themePack?.theme?.fonts || {};
  return {
    brand_name: String(
      override.branding?.brand_name || override.brand_name || themePack?.brand_name || ''
    ),
    design_system_id: String(override.design_system_id || themePack?.design_system_id || ''),
    theme_name: String(themePack?.theme?.name || override.theme || ''),
    theme_primary: String(colors.primary || ''),
    theme_secondary: String(colors.secondary || ''),
    theme_accent: String(colors.accent || ''),
    theme_background: String(colors.background || ''),
    theme_text: String(colors.text || ''),
    font_heading: String(fonts.heading || ''),
    font_body: String(fonts.body || ''),
  };
}

function buildLogoPath(
  rootDir: string,
  overridePath: string,
  override: Record<string, any>,
  themePack: Record<string, any> | null
): string | null {
  const raw =
    override.branding?.logo_url ||
    override.logo_url ||
    themePack?.theme?.assets?.logo_url ||
    themePack?.assets?.logo_url ||
    null;
  if (typeof raw === 'string' && raw.trim()) {
    const candidate = path.resolve(rootDir, raw.trim());
    return isSafeTenantDesignPath(candidate, rootDir, false, path.dirname(overridePath))
      ? candidate
      : null;
  }
  if (overridePath.includes('/design/tenant-override.json')) {
    const fallback = overridePath.replace(
      /\/design\/tenant-override\.json$/,
      '/design/assets/logo.png'
    );
    return isSafeTenantDesignPath(fallback, rootDir, false, path.dirname(overridePath))
      ? fallback
      : null;
  }
  return null;
}

export function resolveTenantDesign(input: ResolveTenantDesignInput): TenantDesignResolution {
  const rootDir = input.rootDir || process.cwd();
  if (!input.brandName && !input.customerId) {
    return {
      source: 'default',
      tokens: {},
      layoutCatalog: null,
      logoPath: null,
      tenantOverride: null,
      themePack: null,
      matchedPath: null,
    };
  }
  const overridePaths = collectTenantOverridePaths(rootDir, input.customerId);

  for (const candidate of overridePaths) {
    const override = readJsonIfPresent(candidate, rootDir);
    if (!override) continue;
    if (!matchesOverride(override, input.brandName, input.designSystemId)) continue;
    const themePackPath = deriveThemePackPath(candidate, override);
    const themePackAbsolute = themePackPath ? path.resolve(rootDir, themePackPath) : null;
    const themePack = themePackAbsolute
      ? readJsonIfPresent(themePackAbsolute, rootDir, path.dirname(candidate))
      : null;
    const layoutCatalogCandidate = deriveLayoutCatalogPath(candidate, override, themePack);
    const layoutCatalog = layoutCatalogCandidate
      ? isSafeTenantDesignPath(
          path.resolve(rootDir, layoutCatalogCandidate),
          rootDir,
          true,
          path.dirname(candidate)
        )
        ? layoutCatalogCandidate
        : null
      : null;
    return {
      source: 'tenant',
      tokens: buildTokens(override, themePack),
      layoutCatalog,
      logoPath: buildLogoPath(rootDir, candidate, override, themePack),
      tenantOverride: override,
      themePack,
      matchedPath: candidate,
    };
  }

  return {
    source: 'default',
    tokens: {},
    layoutCatalog: null,
    logoPath: null,
    tenantOverride: null,
    themePack: null,
    matchedPath: null,
  };
}
