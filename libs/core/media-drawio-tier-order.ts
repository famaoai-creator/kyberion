import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

interface MediaDrawioTierOrderCatalog {
  version: string;
  tier_order: string[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('product/governance/media-drawio-tier-order.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/media-drawio-tier-order.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: MediaDrawioTierOrderCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_CATALOG: MediaDrawioTierOrderCatalog = {
  version: '1.0.0',
  tier_order: ['network', 'edge', 'web', 'application', 'app', 'data', 'database', 'security', 'module', 'control', 'state'],
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

function validateCatalog(value: unknown, label: string): MediaDrawioTierOrderCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid media drawio tier order catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as MediaDrawioTierOrderCatalog;
}

export function loadMediaDrawioTierOrderCatalog(): MediaDrawioTierOrderCatalog {
  if (cachedCatalog && cachedCatalogPath === CATALOG_PATH) return cachedCatalog;
  if (!safeExistsSync(CATALOG_PATH)) {
    cachedCatalog = FALLBACK_CATALOG;
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

export function resolveMediaDrawioTierRank(tier?: string): number {
  const normalized = String(tier || '').trim().toLowerCase();
  const catalog = loadMediaDrawioTierOrderCatalog();
  const index = catalog.tier_order.indexOf(normalized);
  return index >= 0 ? index : catalog.tier_order.length;
}

export function resetMediaDrawioTierOrderCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
