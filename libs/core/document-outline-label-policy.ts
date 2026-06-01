import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface DocumentOutlineLabelPolicyCatalog {
  version: string;
  report_summary_title: string;
  report_section_title: string;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('public/governance/document-outline-label-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/document-outline-label-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: DocumentOutlineLabelPolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_CATALOG: DocumentOutlineLabelPolicyCatalog = {
  version: '1.0.0',
  report_summary_title: 'Summary',
  report_section_title: 'Section',
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

function validateCatalog(value: unknown, label: string): DocumentOutlineLabelPolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid document outline label policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as DocumentOutlineLabelPolicyCatalog;
}

export function loadDocumentOutlineLabelPolicyCatalog(): DocumentOutlineLabelPolicyCatalog {
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

export function resolveReportSummaryTitle(): string {
  return loadDocumentOutlineLabelPolicyCatalog().report_summary_title || 'Summary';
}

export function resolveReportSectionTitle(): string {
  return loadDocumentOutlineLabelPolicyCatalog().report_section_title || 'Section';
}

export function resetDocumentOutlineLabelPolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
