import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface PromotedReportTemplatePolicyCatalog {
  version: string;
  template_sections: string[];
  audience: string;
  output_format: string;
}

const CATALOG_PATH = pathResolver.knowledge(
  'product/governance/promoted-report-template-policy.json'
);
const SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/promoted-report-template-policy.schema.json'
);

const FALLBACK_CATALOG: PromotedReportTemplatePolicyCatalog = {
  version: '1.0.0',
  template_sections: ['Summary', 'Current State', 'Findings', 'Next Actions'],
  audience: 'internal stakeholders',
  output_format: 'structured document',
};

const catalog = defineCatalog<PromotedReportTemplatePolicyCatalog>({
  id: 'promoted-report-template-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: FALLBACK_CATALOG,
});

export function loadPromotedReportTemplatePolicyCatalog(): PromotedReportTemplatePolicyCatalog {
  return catalog.load();
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
  catalog.reset();
}
