import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface PromotedReportTemplatePolicyCatalog {
  version: string;
  template_sections: string[];
  audience: string;
  output_format: string;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('public/governance/promoted-report-template-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/promoted-report-template-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: PromotedReportTemplatePolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_CATALOG: PromotedReportTemplatePolicyCatalog = {
  version: '1.0.0',
  template_sections: ['Summary', 'Current State', 'Findings', 'Next Actions'],
  audience: 'internal stakeholders',
  output_format: 'structured document',
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

function validateCatalog(value: unknown, label: string): PromotedReportTemplatePolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid promoted report template policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as PromotedReportTemplatePolicyCatalog;
}

export function loadPromotedReportTemplatePolicyCatalog(): PromotedReportTemplatePolicyCatalog {
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

export function resolvePromotedReportTemplateSections(): string[] {
  const catalog = loadPromotedReportTemplatePolicyCatalog();
  return Array.isArray(catalog.template_sections) && catalog.template_sections.length > 0
    ? catalog.template_sections
    : FALLBACK_CATALOG.template_sections;
}

export function resolvePromotedReportAudience(): string {
  return loadPromotedReportTemplatePolicyCatalog().audience || FALLBACK_CATALOG.audience;
}

export function resolvePromotedReportOutputFormat(): string {
  return loadPromotedReportTemplatePolicyCatalog().output_format || FALLBACK_CATALOG.output_format;
}

export function resetPromotedReportTemplatePolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
