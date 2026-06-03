import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface ServiceOnboardingCatalogEntry {
  service_id: string;
  prompt_kind: 'comfyui' | 'whisper' | 'generic';
  label?: string;
  notes?: string;
}

interface ServiceOnboardingCatalog {
  version: string;
  services: ServiceOnboardingCatalogEntry[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('product/governance/service-onboarding-catalog.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/service-onboarding-catalog.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: ServiceOnboardingCatalog | null = null;
let cachedCatalogPath: string | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function validateCatalog(value: unknown, label: string): ServiceOnboardingCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim());
    throw new Error(`Invalid service onboarding catalog at ${label}: ${errors.join('; ')}`);
  }
  return value as ServiceOnboardingCatalog;
}

export function loadServiceOnboardingCatalog(): ServiceOnboardingCatalog {
  if (cachedCatalog && cachedCatalogPath === CATALOG_PATH) return cachedCatalog;
  if (!safeExistsSync(CATALOG_PATH)) {
    cachedCatalog = { version: '1.0.0', services: [] };
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

export function listServiceOnboardingCatalogEntries(): ServiceOnboardingCatalogEntry[] {
  return loadServiceOnboardingCatalog().services;
}

export function getServiceOnboardingCatalogEntry(serviceId: string): ServiceOnboardingCatalogEntry | null {
  const normalized = serviceId.trim();
  if (!normalized) return null;
  return listServiceOnboardingCatalogEntries().find((entry) => entry.service_id === normalized) || null;
}
