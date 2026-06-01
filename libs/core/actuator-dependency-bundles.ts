import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface ActuatorDependencyBundleEntry {
  id: string;
  actuator: string;
  dependency_ids: string[];
  summary?: string;
}

interface ActuatorDependencyBundles {
  version: string;
  bundles: ActuatorDependencyBundleEntry[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const PUBLIC_PATH = pathResolver.knowledge('public/governance/actuator-dependency-bundles.json');
const PERSONAL_PATH = pathResolver.knowledge('personal/governance/actuator-dependency-bundles.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/actuator-dependency-bundles.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: ActuatorDependencyBundles | null = null;
let cachedKey: string | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function validateCatalog(value: unknown, label: string): ActuatorDependencyBundles {
  const validate = ensureValidator();
  if (!validate(value)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim());
    throw new Error(`Invalid actuator dependency bundles at ${label}: ${errors.join('; ')}`);
  }
  return value as ActuatorDependencyBundles;
}

function loadCatalogFile(catalogPath: string): ActuatorDependencyBundles | null {
  if (!safeExistsSync(catalogPath)) return null;
  return validateCatalog(JSON.parse(safeReadFile(catalogPath, { encoding: 'utf8' }) as string), catalogPath);
}

function mergeCatalogs(base: ActuatorDependencyBundles, overlay: ActuatorDependencyBundles): ActuatorDependencyBundles {
  const byId = new Map<string, ActuatorDependencyBundleEntry>();
  for (const entry of base.bundles) byId.set(entry.id, entry);
  for (const entry of overlay.bundles) byId.set(entry.id, entry);
  return { version: overlay.version || base.version || '1.0.0', bundles: Array.from(byId.values()) };
}

export function loadActuatorDependencyBundles(): ActuatorDependencyBundles {
  const cacheKey = `${PUBLIC_PATH}::${PERSONAL_PATH}`;
  if (cachedCatalog && cachedKey === cacheKey) return cachedCatalog;

  const base = loadCatalogFile(PUBLIC_PATH) ?? { version: '1.0.0', bundles: [] };
  const personal = loadCatalogFile(PERSONAL_PATH) ?? { version: base.version, bundles: [] };
  const merged = mergeCatalogs(base, personal);

  cachedCatalog = merged;
  cachedKey = cacheKey;
  return merged;
}

export function getActuatorDependencyBundle(actuator: string): ActuatorDependencyBundleEntry | null {
  const normalized = actuator.trim();
  if (!normalized) return null;
  return loadActuatorDependencyBundles().bundles.find((bundle) => bundle.actuator === normalized) || null;
}

export function resetActuatorDependencyBundlesCache(): void {
  cachedCatalog = null;
  cachedKey = null;
}
