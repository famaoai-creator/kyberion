import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface OnboardingSummaryPolicyCatalog {
  version: string;
  title: string;
  sections: {
    identity: string;
    services: string;
    tenants: string;
    tutorial: string;
    next_steps: string;
  };
  empty_states: {
    services: string;
    tenants: string;
  };
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('public/governance/onboarding-summary-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/onboarding-summary-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: OnboardingSummaryPolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_CATALOG: OnboardingSummaryPolicyCatalog = {
  version: '1.0.0',
  title: 'Kyberion Onboarding Summary',
  sections: {
    identity: 'Identity',
    services: 'Services',
    tenants: 'Tenants',
    tutorial: 'Tutorial',
    next_steps: 'Next Steps',
  },
  empty_states: {
    services: 'None captured yet',
    tenants: 'None registered yet',
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

function validateCatalog(value: unknown, label: string): OnboardingSummaryPolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid onboarding summary policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as OnboardingSummaryPolicyCatalog;
}

export function loadOnboardingSummaryPolicyCatalog(): OnboardingSummaryPolicyCatalog {
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

export function resolveOnboardingSummaryPolicy(): OnboardingSummaryPolicyCatalog {
  return loadOnboardingSummaryPolicyCatalog();
}

export function resetOnboardingSummaryPolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
