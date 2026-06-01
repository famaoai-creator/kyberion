import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface DocumentContentsPolicyCatalog {
  version: string;
  title_by_locale: Record<string, string>;
  subtitle: string;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('public/governance/document-contents-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/document-contents-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: DocumentContentsPolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_CATALOG: DocumentContentsPolicyCatalog = {
  version: '1.0.0',
  title_by_locale: {
    ja: '目次',
    default: 'Contents',
  },
  subtitle: 'Document navigation',
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

function validateCatalog(value: unknown, label: string): DocumentContentsPolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid document contents policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as DocumentContentsPolicyCatalog;
}

export function loadDocumentContentsPolicyCatalog(): DocumentContentsPolicyCatalog {
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

export function resolveDocumentContentsLabel(locale?: string): string {
  const normalized = String(locale || '').trim().toLowerCase();
  const catalog = loadDocumentContentsPolicyCatalog();
  if (normalized.startsWith('ja')) return catalog.title_by_locale.ja || catalog.title_by_locale.default || 'Contents';
  return catalog.title_by_locale.default || 'Contents';
}

export function resolveDocumentContentsSubtitle(): string {
  return loadDocumentContentsPolicyCatalog().subtitle || 'Document navigation';
}

export function resetDocumentContentsPolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
