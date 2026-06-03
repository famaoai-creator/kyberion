import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface MissionLedgerPolicyCatalog {
  version: string;
  section_title: string;
  table_headers: {
    mission_id: string;
    relationship: string;
    status: string;
    summary: string;
    affected_artifacts: string;
    gate_impact: string;
    traceability_refs: string;
  };
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('product/governance/mission-ledger-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/mission-ledger-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: MissionLedgerPolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_CATALOG: MissionLedgerPolicyCatalog = {
  version: '1.0.0',
  section_title: 'Mission Ledger',
  table_headers: {
    mission_id: 'Mission ID',
    relationship: 'Relationship',
    status: 'Status',
    summary: 'Summary',
    affected_artifacts: 'Affected Artifacts',
    gate_impact: 'Gate Impact',
    traceability_refs: 'Traceability Refs',
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

function validateCatalog(value: unknown, label: string): MissionLedgerPolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid mission ledger policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as MissionLedgerPolicyCatalog;
}

export function loadMissionLedgerPolicyCatalog(): MissionLedgerPolicyCatalog {
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

export function resolveMissionLedgerPolicy(): MissionLedgerPolicyCatalog {
  return loadMissionLedgerPolicyCatalog();
}

export function resetMissionLedgerPolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
