import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { normalizeLocale } from './locale-normalize.js';

export interface DocumentContentsPolicyCatalog {
  version: string;
  title_by_locale: Record<string, string>;
  subtitle: string;
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/document-contents-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/document-contents-policy.schema.json');

const catalog = defineCatalog<DocumentContentsPolicyCatalog>({
  id: 'document-contents-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadDocumentContentsPolicyCatalog(): DocumentContentsPolicyCatalog {
  return catalog.load();
}

export function resolveDocumentContentsLabel(locale?: string): string {
  // I18N-02: generic over whatever locale keys `title_by_locale` happens to
  // carry — no hardcoded `ja` special case. Adding a locale is a data edit
  // to the catalog (plus a `default` fallback), not a code change here.
  const normalized = normalizeLocale(locale);
  const catalog = loadDocumentContentsPolicyCatalog();
  if (normalized && catalog.title_by_locale[normalized]) {
    return catalog.title_by_locale[normalized];
  }
  return catalog.title_by_locale.default || 'Contents';
}

export function resolveDocumentContentsSubtitle(): string {
  return loadDocumentContentsPolicyCatalog().subtitle || 'Document navigation';
}
