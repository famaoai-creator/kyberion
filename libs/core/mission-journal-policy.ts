import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface MissionJournalPolicyCatalog {
  version: string;
  title: string;
  summary_title: string;
  trust_scores_title: string;
  empty_message: string;
  relationship_labels: {
    prerequisites: string;
    successors: string;
  };
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('product/governance/mission-journal-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/mission-journal-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: MissionJournalPolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_CATALOG: MissionJournalPolicyCatalog = {
  version: '1.0.0',
  title: 'Mission Journal: Ecosystem Evolution',
  summary_title: 'Summary',
  trust_scores_title: 'Agent Trust Scores',
  empty_message: 'No missions recorded yet.',
  relationship_labels: {
    prerequisites: 'Prerequisites',
    successors: 'Successors',
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

function validateCatalog(value: unknown, label: string): MissionJournalPolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid mission journal policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as MissionJournalPolicyCatalog;
}

export function loadMissionJournalPolicyCatalog(): MissionJournalPolicyCatalog {
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

export function resolveMissionJournalPolicy(): MissionJournalPolicyCatalog {
  return loadMissionJournalPolicyCatalog();
}

export function resetMissionJournalPolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
