import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { recordConfigFallback } from './config-fallback-registry.js';

export interface MediaThemeRolePolicyCatalog {
  version: string;
  theme_color_roles: Record<string, string>;
  theme_hex_roles: Record<string, string>;
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/media-theme-role-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/media-theme-role-policy.schema.json');

const FALLBACK_POLICY: MediaThemeRolePolicyCatalog = {
  version: '1.0.0',
  theme_color_roles: {
    accent: 'accent',
    secondary: 'secondary',
    primary: 'primary',
    default: 'secondary',
  },
  theme_hex_roles: {
    accent: 'accent',
    primary: 'primary',
    secondary: 'secondary',
    background: 'background',
    success: 'success',
    warning: 'warning',
    danger: 'danger',
  },
};

const catalog = defineCatalog<MediaThemeRolePolicyCatalog>({
  id: 'media-theme-role-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: FALLBACK_POLICY,
  onFallback: (error, fallback) =>
    recordConfigFallback({ knowledgePath: CATALOG_PATH, error, defaults: fallback }),
});

export function loadMediaThemeRolePolicyCatalog(): MediaThemeRolePolicyCatalog {
  return catalog.load();
}

export function resolveThemeColorRole(role?: string, fallback = 'secondary'): string {
  const normalized = String(role || '').trim();
  if (!normalized) return fallback;
  const catalog = loadMediaThemeRolePolicyCatalog();
  return catalog.theme_color_roles[normalized] || catalog.theme_color_roles.default || fallback;
}

export function resolveThemeHexRole(role?: string, fallback = '#334155'): string {
  const normalized = String(role || '').trim();
  if (!normalized) return fallback;
  const catalog = loadMediaThemeRolePolicyCatalog();
  return catalog.theme_hex_roles[normalized] || fallback;
}

export function resetMediaThemeRolePolicyCatalogCache(): void {
  catalog.reset();
}
