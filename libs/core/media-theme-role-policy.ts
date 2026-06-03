import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface MediaThemeRolePolicyCatalog {
  version: string;
  theme_color_roles: Record<string, string>;
  theme_hex_roles: Record<string, string>;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('product/governance/media-theme-role-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/media-theme-role-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: MediaThemeRolePolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

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

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function validateCatalog(value: unknown, label: string): MediaThemeRolePolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid media theme role policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as MediaThemeRolePolicyCatalog;
}

export function loadMediaThemeRolePolicyCatalog(): MediaThemeRolePolicyCatalog {
  if (cachedCatalog && cachedCatalogPath === CATALOG_PATH) return cachedCatalog;
  if (!safeExistsSync(CATALOG_PATH)) {
    cachedCatalog = FALLBACK_POLICY;
    cachedCatalogPath = CATALOG_PATH;
    return cachedCatalog;
  }
  const parsed = validateCatalog(
    JSON.parse(safeReadFile(CATALOG_PATH, { encoding: 'utf8' }) as string),
    CATALOG_PATH
  );
  cachedCatalog = parsed;
  cachedCatalogPath = CATALOG_PATH;
  return parsed;
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
  cachedCatalog = null;
  cachedCatalogPath = null;
}
