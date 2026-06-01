import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { matchesAnyTextRule, type TextMatchRule } from './text-rule-matcher.js';

export interface ServiceBootstrapCatalogEntry {
  id: string;
  service_id: string;
  service_type: string;
  binding_id: string;
  scope: string;
  target: string;
  allowed_actions: string[];
  utterance_patterns?: Array<TextMatchRule | string>;
  default_for_surfaces?: string[];
  summary?: string;
}

interface ServiceBootstrapCatalog {
  version: string;
  entries: ServiceBootstrapCatalogEntry[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const PUBLIC_CATALOG_PATH = pathResolver.knowledge('public/governance/service-bootstrap-catalog.json');
const PERSONAL_CATALOG_PATH = pathResolver.knowledge('personal/governance/service-bootstrap-catalog.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/service-bootstrap-catalog.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: ServiceBootstrapCatalog | null = null;
let cachedCatalogKey: string | null = null;

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

function validateCatalog(value: unknown, label: string): ServiceBootstrapCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid service bootstrap catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as ServiceBootstrapCatalog;
}

function loadCatalogFile(catalogPath: string): ServiceBootstrapCatalog | null {
  if (!safeExistsSync(catalogPath)) return null;
  return validateCatalog(
    JSON.parse(safeReadFile(catalogPath, { encoding: 'utf8' }) as string),
    catalogPath
  );
}

function mergeCatalogs(base: ServiceBootstrapCatalog, overlay: ServiceBootstrapCatalog): ServiceBootstrapCatalog {
  const byId = new Map<string, ServiceBootstrapCatalogEntry>();
  for (const entry of base.entries) byId.set(entry.id, entry);
  for (const entry of overlay.entries) byId.set(entry.id, entry);
  return {
    version: overlay.version || base.version || '1.0.0',
    entries: Array.from(byId.values()),
  };
}

export function loadServiceBootstrapCatalog(): ServiceBootstrapCatalog {
  const cacheKey = `${PUBLIC_CATALOG_PATH}::${PERSONAL_CATALOG_PATH}`;
  if (cachedCatalog && cachedCatalogKey === cacheKey) return cachedCatalog;

  const base = loadCatalogFile(PUBLIC_CATALOG_PATH) ?? { version: '1.0.0', entries: [] };
  const personal = loadCatalogFile(PERSONAL_CATALOG_PATH) ?? { version: base.version, entries: [] };
  const merged = mergeCatalogs(base, personal);

  cachedCatalog = merged;
  cachedCatalogKey = cacheKey;
  return merged;
}

export function listServiceBootstrapCatalogEntries(): ServiceBootstrapCatalogEntry[] {
  return loadServiceBootstrapCatalog().entries;
}

export function findServiceBootstrapEntriesByUtterance(utterance: string): ServiceBootstrapCatalogEntry[] {
  const normalized = utterance.trim();
  if (!normalized) return [];
  return listServiceBootstrapCatalogEntries().filter((entry) =>
    matchesAnyTextRule(normalized, entry.utterance_patterns)
  );
}

export function getServiceBootstrapCatalogEntryByServiceId(serviceId: string): ServiceBootstrapCatalogEntry | null {
  const normalized = serviceId.trim();
  if (!normalized) return null;
  return listServiceBootstrapCatalogEntries().find((entry) => entry.service_id === normalized) || null;
}

export function getDefaultServiceIdForSurface(surface: string): string | null {
  const normalized = surface.trim();
  if (!normalized) return null;
  const matched = listServiceBootstrapCatalogEntries().find((entry) =>
    (entry.default_for_surfaces || []).includes(normalized)
  );
  return matched?.service_id || null;
}

export function resetServiceBootstrapCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogKey = null;
}
