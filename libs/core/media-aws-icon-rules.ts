import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface MediaAwsIconRuleEntry {
  match_type: 'starts_with' | 'contains';
  match_value: string;
  icons: string[];
}

interface MediaAwsIconRuleCatalog {
  version: string;
  exact_resources: Record<string, string[]>;
  rules: MediaAwsIconRuleEntry[];
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/media-aws-icon-rules.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/media-aws-icon-rules.schema.json');

const catalog = defineCatalog<MediaAwsIconRuleCatalog>({
  id: 'media-aws-icon-rules',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadMediaAwsIconRuleCatalog(): MediaAwsIconRuleCatalog {
  return catalog.load();
}

export function resolveMediaAwsIconCandidates(resourceType: string): string[] {
  const normalized = String(resourceType || '').trim();
  if (!normalized) return [];
  const catalog = loadMediaAwsIconRuleCatalog();
  const exact = catalog.exact_resources[normalized];
  if (Array.isArray(exact) && exact.length > 0) return exact;
  for (const rule of catalog.rules) {
    if (rule.match_type === 'starts_with' && normalized.startsWith(rule.match_value))
      return rule.icons;
    if (rule.match_type === 'contains' && normalized.includes(rule.match_value)) return rule.icons;
  }
  return [];
}
