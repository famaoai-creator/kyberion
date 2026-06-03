import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface OnboardingFlowPolicyCatalog {
  version: string;
  phase_titles: {
    identity: string;
    services: string;
    tenants: string;
    tutorial: string;
    summary: string;
  };
  tutorial_plan_title: string;
  tutorial_next_step_title: string;
  tutorial_skipped_message: string;
  tutorial_default_summary: string;
  complete_message: string;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('product/governance/onboarding-flow-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/onboarding-flow-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: OnboardingFlowPolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_CATALOG: OnboardingFlowPolicyCatalog = {
  version: '1.0.0',
  phase_titles: {
    identity: 'Identity & Purpose',
    services: 'Infrastructure & Services',
    tenants: 'Multi-Tenant Registration',
    tutorial: 'Hands-on Tutorial',
    summary: 'Summary',
  },
  tutorial_plan_title: 'Onboarding Tutorial Plan',
  tutorial_next_step_title: 'Suggested next step',
  tutorial_skipped_message: 'Tutorial skipped during onboarding.',
  tutorial_default_summary: 'Demonstrate the initial Kyberion setup with a safe dry-run.',
  complete_message: 'Onboarding complete.',
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

function validateCatalog(value: unknown, label: string): OnboardingFlowPolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid onboarding flow policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as OnboardingFlowPolicyCatalog;
}

export function loadOnboardingFlowPolicyCatalog(): OnboardingFlowPolicyCatalog {
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

export function resolveOnboardingFlowPolicy(): OnboardingFlowPolicyCatalog {
  return loadOnboardingFlowPolicyCatalog();
}

export function resetOnboardingFlowPolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
