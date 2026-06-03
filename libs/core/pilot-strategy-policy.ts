import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface PilotStrategyPolicyCatalog {
  version: string;
  title: string;
  target: string;
  value_proposition_title: string;
  market_strategy_title: string;
  key_benefits_title: string;
  phase_titles: {
    education: string;
    pilot: string;
    expansion: string;
  };
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('product/governance/pilot-strategy-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/pilot-strategy-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: PilotStrategyPolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_CATALOG: PilotStrategyPolicyCatalog = {
  version: '1.0.0',
  title: 'Kyberion AI Consulting: Go-to-Market Strategy',
  target: 'Japanese Mid-sized Enterprise (SMB) Managers',
  value_proposition_title: 'Value Proposition: "Safety through Governance"',
  market_strategy_title: 'Market Strategy (Japanese SMB Focus)',
  key_benefits_title: 'Key Benefits',
  phase_titles: {
    education: 'Education',
    pilot: 'Pilot',
    expansion: 'Expansion',
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

function validateCatalog(value: unknown, label: string): PilotStrategyPolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid pilot strategy policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as PilotStrategyPolicyCatalog;
}

export function loadPilotStrategyPolicyCatalog(): PilotStrategyPolicyCatalog {
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

export function resolvePilotStrategyPolicy(): PilotStrategyPolicyCatalog {
  return loadPilotStrategyPolicyCatalog();
}

export function resetPilotStrategyPolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
