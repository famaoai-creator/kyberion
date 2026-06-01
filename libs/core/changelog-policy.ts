import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface ChangelogPolicyCatalog {
  version: string;
  breaking_changes_title: string;
  uncategorized_title: string;
  no_commits_template: string;
  header_template: string;
  type_labels: Record<string, string>;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('public/governance/changelog-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/changelog-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: ChangelogPolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

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

function validateCatalog(value: unknown, label: string): ChangelogPolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid changelog policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as ChangelogPolicyCatalog;
}

export function loadChangelogPolicyCatalog(): ChangelogPolicyCatalog {
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

export function resolveChangelogPolicy(): ChangelogPolicyCatalog {
  return loadChangelogPolicyCatalog();
}

export function resetChangelogPolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
