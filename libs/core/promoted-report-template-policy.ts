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

const catalog = defineCatalog<PromotedReportTemplatePolicyCatalog>({
  id: 'promoted-report-template-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadPromotedReportTemplatePolicyCatalog(): PromotedReportTemplatePolicyCatalog {
  return catalog.load();
}

export function resolvePromotedReportTemplateSections(): string[] {
  const catalog = loadPromotedReportTemplatePolicyCatalog();
  return catalog.template_sections;
}

export function resolvePromotedReportAudience(): string {
  return loadPromotedReportTemplatePolicyCatalog().audience;
}

export function resolvePromotedReportOutputFormat(): string {
  return loadPromotedReportTemplatePolicyCatalog().output_format;
}
