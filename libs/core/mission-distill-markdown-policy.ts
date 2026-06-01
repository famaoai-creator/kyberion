import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface MissionDistillMarkdownPolicyCatalog {
  version: string;
  title_suffix: string;
  section_titles: {
    summary: string;
    key_learnings: string;
    patterns_discovered: string;
    failures_and_recoveries: string;
    reusable_artifacts: string;
  };
  prompt_titles: {
    mission_state: string;
    evidence_context: string;
  };
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('public/governance/mission-distill-markdown-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/mission-distill-markdown-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: MissionDistillMarkdownPolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_CATALOG: MissionDistillMarkdownPolicyCatalog = {
  version: '1.0.0',
  title_suffix: 'Completion Summary',
  section_titles: {
    summary: 'Summary',
    key_learnings: 'Key Learnings',
    patterns_discovered: 'Patterns Discovered',
    failures_and_recoveries: 'Failures & Recoveries',
    reusable_artifacts: 'Reusable Artifacts',
  },
  prompt_titles: {
    mission_state: 'Mission State',
    evidence_context: 'Evidence & Context',
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

function validateCatalog(value: unknown, label: string): MissionDistillMarkdownPolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid mission distill markdown policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as MissionDistillMarkdownPolicyCatalog;
}

export function loadMissionDistillMarkdownPolicyCatalog(): MissionDistillMarkdownPolicyCatalog {
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

export function resolveMissionDistillMarkdownPolicy(): MissionDistillMarkdownPolicyCatalog {
  return loadMissionDistillMarkdownPolicyCatalog();
}

export function resetMissionDistillMarkdownPolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
