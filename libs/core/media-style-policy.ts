import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface MediaBorderKeySideEntry {
  key_char: 'T' | 'B' | 'L' | 'R';
  side: 'top' | 'bottom' | 'left' | 'right';
}

interface MediaStylePolicyCatalog {
  version: string;
  signal_tone_ranks: Record<string, number>;
  border_key_sides: MediaBorderKeySideEntry[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('public/governance/media-style-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/media-style-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: MediaStylePolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_SIGNAL_TONE_RANKS: Record<string, number> = {
  danger: 0,
  critical: 0,
  high: 0,
  warning: 1,
  medium: 1,
  info: 2,
  success: 3,
  low: 3,
};

const FALLBACK_BORDER_KEY_SIDES: MediaBorderKeySideEntry[] = [
  { key_char: 'T', side: 'top' },
  { key_char: 'B', side: 'bottom' },
  { key_char: 'L', side: 'left' },
  { key_char: 'R', side: 'right' },
];

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

function validateCatalog(value: unknown, label: string): MediaStylePolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid media style policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as MediaStylePolicyCatalog;
}

export function loadMediaStylePolicyCatalog(): MediaStylePolicyCatalog {
  if (cachedCatalog && cachedCatalogPath === CATALOG_PATH) return cachedCatalog;
  if (!safeExistsSync(CATALOG_PATH)) {
    cachedCatalog = {
      version: '1.0.0',
      signal_tone_ranks: FALLBACK_SIGNAL_TONE_RANKS,
      border_key_sides: FALLBACK_BORDER_KEY_SIDES,
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

export function resolveSignalToneRank(tone?: string): number {
  const normalized = String(tone || '').trim().toLowerCase();
  if (!normalized) return 2;
  const catalog = loadMediaStylePolicyCatalog();
  return catalog.signal_tone_ranks[normalized] ?? FALLBACK_SIGNAL_TONE_RANKS[normalized] ?? 2;
}

export function resolveBorderKeySides(key: string): Array<'top' | 'bottom' | 'left' | 'right'> {
  const normalized = String(key || '').trim().toUpperCase();
  if (!normalized) return [];
  const catalog = loadMediaStylePolicyCatalog();
  const sides = new Set<'top' | 'bottom' | 'left' | 'right'>();
  for (const entry of catalog.border_key_sides) {
    if (normalized.includes(entry.key_char)) sides.add(entry.side);
  }
  return Array.from(sides);
}

export function resetMediaStylePolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
