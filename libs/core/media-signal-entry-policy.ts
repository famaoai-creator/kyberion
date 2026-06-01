import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface MediaSignalEntryPolicyItem {
  source_key: string;
  signal_type: string;
  default_tone: string;
  title_fields: string[];
  owner_fields: string[];
  status_fields: string[];
}

interface MediaSignalEntryPolicyCatalog {
  version: string;
  sheet_title: string;
  columns: string[];
  empty_message: string;
  elevated_tones: string[];
  elevated_status_keywords: string[];
  entry_types: MediaSignalEntryPolicyItem[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('public/governance/media-signal-entry-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/media-signal-entry-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: MediaSignalEntryPolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_ENTRY_TYPES: MediaSignalEntryPolicyItem[] = [
  {
    source_key: 'signals',
    signal_type: 'signal',
    default_tone: 'info',
    title_fields: ['title', 'name', 'summary'],
    owner_fields: ['owner', 'assignee', 'team', 'function'],
    status_fields: ['status', 'tone', 'state'],
  },
  {
    source_key: 'risks',
    signal_type: 'risk',
    default_tone: 'warning',
    title_fields: ['title', 'name', 'risk', 'summary'],
    owner_fields: ['owner', 'assignee', 'team', 'function'],
    status_fields: ['status', 'severity', 'tone', 'state'],
  },
  {
    source_key: 'incidents',
    signal_type: 'incident',
    default_tone: 'danger',
    title_fields: ['title', 'name', 'incident', 'summary'],
    owner_fields: ['owner', 'assignee', 'team', 'function'],
    status_fields: ['status', 'severity', 'tone', 'state'],
  },
  {
    source_key: 'controls',
    signal_type: 'control',
    default_tone: 'info',
    title_fields: ['title', 'name', 'control', 'summary'],
    owner_fields: ['owner', 'assignee', 'team', 'function'],
    status_fields: ['status', 'severity', 'tone', 'state'],
  },
];

const FALLBACK_CATALOG_META = {
  sheet_title: 'Signals and Risks',
  columns: ['Task', 'Owner', 'Status'],
  empty_message: 'No elevated signals detected.',
  elevated_tones: ['warning', 'danger'],
  elevated_status_keywords: ['risk', 'blocked', 'late', 'issue'],
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

function validateCatalog(value: unknown, label: string): MediaSignalEntryPolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid media signal entry policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as MediaSignalEntryPolicyCatalog;
}

export function loadMediaSignalEntryPolicyCatalog(): MediaSignalEntryPolicyCatalog {
  if (cachedCatalog && cachedCatalogPath === CATALOG_PATH) return cachedCatalog;
  if (!safeExistsSync(CATALOG_PATH)) {
    cachedCatalog = {
      version: '1.0.0',
      ...FALLBACK_CATALOG_META,
      entry_types: FALLBACK_ENTRY_TYPES,
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

export function resolveMediaSignalEntryPolicy(sourceKey: string): MediaSignalEntryPolicyItem | null {
  const normalized = String(sourceKey || '').trim().toLowerCase();
  if (!normalized) return null;
  const catalog = loadMediaSignalEntryPolicyCatalog();
  return catalog.entry_types.find((entry) => entry.source_key === normalized) || null;
}

export function resetMediaSignalEntryPolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
