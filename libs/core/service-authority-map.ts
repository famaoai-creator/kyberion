import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface ServiceAuthorityMapEntry {
  id: string;
  service_id: string;
  authorities: string[];
  summary?: string;
}

interface ServiceAuthorityMap {
  version: string;
  services: ServiceAuthorityMapEntry[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const PUBLIC_MAP_PATH = pathResolver.knowledge('public/governance/service-authority-map.json');
const PERSONAL_MAP_PATH = pathResolver.knowledge('personal/governance/service-authority-map.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/service-authority-map.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedMap: ServiceAuthorityMap | null = null;
let cachedMapKey: string | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim());
}

function validateMap(value: unknown, label: string): ServiceAuthorityMap {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid service authority map at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as ServiceAuthorityMap;
}

function loadMapFile(mapPath: string): ServiceAuthorityMap | null {
  if (!safeExistsSync(mapPath)) return null;
  return validateMap(JSON.parse(safeReadFile(mapPath, { encoding: 'utf8' }) as string), mapPath);
}

function mergeMaps(base: ServiceAuthorityMap, overlay: ServiceAuthorityMap): ServiceAuthorityMap {
  const byId = new Map<string, ServiceAuthorityMapEntry>();
  for (const entry of base.services) byId.set(entry.id, entry);
  for (const entry of overlay.services) byId.set(entry.id, entry);
  return {
    version: overlay.version || base.version || '1.0.0',
    services: Array.from(byId.values()),
  };
}

export function loadServiceAuthorityMap(): ServiceAuthorityMap {
  const cacheKey = `${PUBLIC_MAP_PATH}::${PERSONAL_MAP_PATH}`;
  if (cachedMap && cachedMapKey === cacheKey) return cachedMap;

  const base = loadMapFile(PUBLIC_MAP_PATH) ?? { version: '1.0.0', services: [] };
  const personal = loadMapFile(PERSONAL_MAP_PATH) ?? { version: base.version, services: [] };
  const merged = mergeMaps(base, personal);

  cachedMap = merged;
  cachedMapKey = cacheKey;
  return merged;
}

export function listServiceAuthorityMapEntries(): ServiceAuthorityMapEntry[] {
  return loadServiceAuthorityMap().services;
}

export function getServiceAuthorities(serviceId: string): string[] {
  const normalized = serviceId.trim();
  if (!normalized) return [];
  return listServiceAuthorityMapEntries().find((entry) => entry.service_id === normalized)?.authorities || [];
}

export function resetServiceAuthorityMapCache(): void {
  cachedMap = null;
  cachedMapKey = null;
}
