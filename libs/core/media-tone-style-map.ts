import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface MediaToneStyleMapEntry {
  tone: string;
  style: 'base' | 'title' | 'subtitle' | 'header' | 'section' | 'info' | 'success' | 'warning' | 'danger' | 'body';
}

interface MediaToneStyleMapCatalog {
  version: string;
  tones: MediaToneStyleMapEntry[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('public/governance/media-tone-style-map.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/media-tone-style-map.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: MediaToneStyleMapCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_MAP: Record<string, MediaToneStyleMapEntry['style']> = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
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

function validateCatalog(value: unknown, label: string): MediaToneStyleMapCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid media tone style map catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as MediaToneStyleMapCatalog;
}

export function loadMediaToneStyleMapCatalog(): MediaToneStyleMapCatalog {
  if (cachedCatalog && cachedCatalogPath === CATALOG_PATH) return cachedCatalog;
  if (!safeExistsSync(CATALOG_PATH)) {
    cachedCatalog = {
      version: '1.0.0',
      tones: Object.entries(FALLBACK_MAP).map(([tone, style]) => ({ tone, style })),
    };
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

export function resolveMediaToneStyle(tone?: string): MediaToneStyleMapEntry['style'] {
  const normalized = String(tone || '').trim().toLowerCase();
  if (!normalized) return 'info';
  const catalog = loadMediaToneStyleMapCatalog();
  const resolved = catalog.tones.find((entry) => entry.tone === normalized)?.style;
  return resolved || FALLBACK_MAP[normalized] || 'info';
}

export function resetMediaToneStyleMapCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
