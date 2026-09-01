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

const FALLBACK_CATALOG: ChangelogPolicyCatalog = {
  version: '1.0.0',
  breaking_changes_title: '⚠ BREAKING CHANGES',
  uncategorized_title: 'Uncategorized',
  no_commits_template: '_No commits between {from} and {to}._',
  header_template: '# Changes since {from} ({count} commits)',
  type_labels: {
    feat: 'Added',
    fix: 'Fixed',
    perf: 'Performance',
    refactor: 'Changed (internal)',
    docs: 'Documentation',
    test: 'Tests',
    build: 'Build',
    ci: 'CI',
    chore: 'Chore',
    revert: 'Reverted',
    security: 'Security',
  },
};

const catalog = defineCatalog<ChangelogPolicyCatalog>({
  id: 'changelog-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: FALLBACK_CATALOG,
});

export function loadChangelogPolicyCatalog(): ChangelogPolicyCatalog {
  return catalog.load();
}

export function resolveChangelogPolicy(): ChangelogPolicyCatalog {
  return loadChangelogPolicyCatalog();
}
