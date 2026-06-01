import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';
import type { GovernedArtifactRole } from './artifact-store.js';

interface SurfaceCoordinationRoleMap {
  version: string;
  entries: Array<{
    surface: string;
    role: GovernedArtifactRole;
    summary?: string;
  }>;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const PUBLIC_MAP_PATH = pathResolver.knowledge('public/governance/surface-coordination-role-map.json');
const PERSONAL_MAP_PATH = pathResolver.knowledge('personal/governance/surface-coordination-role-map.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/surface-coordination-role-map.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedMap: SurfaceCoordinationRoleMap | null = null;
let cachedMapKey: string | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function validateMap(value: unknown, label: string): SurfaceCoordinationRoleMap {
  const validate = ensureValidator();
  if (!validate(value)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim());
    throw new Error(`Invalid surface coordination role map at ${label}: ${errors.join('; ')}`);
  }
  return value as SurfaceCoordinationRoleMap;
}

function loadMapFile(mapPath: string): SurfaceCoordinationRoleMap | null {
  if (!safeExistsSync(mapPath)) return null;
  return validateMap(JSON.parse(safeReadFile(mapPath, { encoding: 'utf8' }) as string), mapPath);
}

function mergeMaps(base: SurfaceCoordinationRoleMap, overlay: SurfaceCoordinationRoleMap): SurfaceCoordinationRoleMap {
  const bySurface = new Map<string, { surface: string; role: GovernedArtifactRole; summary?: string }>();
  for (const entry of base.entries) bySurface.set(entry.surface, entry);
  for (const entry of overlay.entries) bySurface.set(entry.surface, entry);
  return {
    version: overlay.version || base.version || '1.0.0',
    entries: Array.from(bySurface.values()),
  };
}

export function getSurfaceCoordinationRole(surface: string): GovernedArtifactRole {
  const normalized = surface.trim();
  if (!normalized) return 'surface_runtime';
  const mapKey = `${PUBLIC_MAP_PATH}::${PERSONAL_MAP_PATH}`;
  if (!cachedMap || cachedMapKey !== mapKey) {
    const base = loadMapFile(PUBLIC_MAP_PATH) ?? { version: '1.0.0', entries: [] };
    const personal = loadMapFile(PERSONAL_MAP_PATH) ?? { version: base.version, entries: [] };
    cachedMap = mergeMaps(base, personal);
    cachedMapKey = mapKey;
  }
  return cachedMap.entries.find((entry) => entry.surface === normalized)?.role || 'surface_runtime';
}

export function resetSurfaceCoordinationRoleMapCache(): void {
  cachedMap = null;
  cachedMapKey = null;
}
