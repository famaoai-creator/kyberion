import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface ChangelogPolicyCatalog {
  version: string;
  breaking_changes_title: string;
  uncategorized_title: string;
  no_commits_template: string;
  header_template: string;
  type_labels: Record<string, string>;
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/changelog-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/changelog-policy.schema.json');

const catalog = defineCatalog<ChangelogPolicyCatalog>({
  id: 'changelog-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadChangelogPolicyCatalog(): ChangelogPolicyCatalog {
  return catalog.load();
}

export function resolveChangelogPolicy(): ChangelogPolicyCatalog {
  return loadChangelogPolicyCatalog();
}
