import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface DocumentOutlineLabelPolicyCatalog {
  version: string;
  report_summary_title: string;
  report_section_title: string;
}

const CATALOG_PATH = pathResolver.knowledge(
  'product/governance/document-outline-label-policy.json'
);
const SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/document-outline-label-policy.schema.json'
);

const FALLBACK_CATALOG: DocumentOutlineLabelPolicyCatalog = {
  version: '1.0.0',
  report_summary_title: 'Summary',
  report_section_title: 'Section',
};

const catalog = defineCatalog<DocumentOutlineLabelPolicyCatalog>({
  id: 'document-outline-label-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: FALLBACK_CATALOG,
});

export function loadDocumentOutlineLabelPolicyCatalog(): DocumentOutlineLabelPolicyCatalog {
  return catalog.load();
}

export function resolveReportSummaryTitle(): string {
  return loadDocumentOutlineLabelPolicyCatalog().report_summary_title || 'Summary';
}

export function resolveReportSectionTitle(): string {
  return loadDocumentOutlineLabelPolicyCatalog().report_section_title || 'Section';
}

export function resetDocumentOutlineLabelPolicyCatalogCache(): void {
  catalog.reset();
}
