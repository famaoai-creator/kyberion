import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface SkillInstallPackageMapEntry {
  id: string;
  patterns: string[];
  install_type: 'brew' | 'pip';
  package_name: string;
  summary?: string;
}

interface SkillInstallPackageMap {
  version: string;
  entries: SkillInstallPackageMapEntry[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const MAP_PATH = pathResolver.knowledge('public/governance/skill-install-package-map.json');
const PERSONAL_MAP_PATH = pathResolver.knowledge('personal/governance/skill-install-package-map.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/skill-install-package-map.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedMap: SkillInstallPackageMap | null = null;
let cachedKey: string | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function validateMap(value: unknown, label: string): SkillInstallPackageMap {
  const validate = ensureValidator();
  if (!validate(value)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim());
    throw new Error(`Invalid skill install package map at ${label}: ${errors.join('; ')}`);
  }
  return value as SkillInstallPackageMap;
}

function loadMapFile(mapPath: string): SkillInstallPackageMap | null {
  if (!safeExistsSync(mapPath)) return null;
  return validateMap(JSON.parse(safeReadFile(mapPath, { encoding: 'utf8' }) as string), mapPath);
}

function mergeMaps(base: SkillInstallPackageMap, overlay: SkillInstallPackageMap): SkillInstallPackageMap {
  const byId = new Map<string, SkillInstallPackageMapEntry>();
  for (const entry of base.entries) byId.set(entry.id, entry);
  for (const entry of overlay.entries) byId.set(entry.id, entry);
  return { version: overlay.version || base.version || '1.0.0', entries: Array.from(byId.values()) };
}

export function loadSkillInstallPackageMap(): SkillInstallPackageMap {
  const key = `${MAP_PATH}::${PERSONAL_MAP_PATH}`;
  if (cachedMap && cachedKey === key) return cachedMap;

  const base = loadMapFile(MAP_PATH) ?? { version: '1.0.0', entries: [] };
  const personal = loadMapFile(PERSONAL_MAP_PATH) ?? { version: base.version, entries: [] };
  const merged = mergeMaps(base, personal);

  cachedMap = merged;
  cachedKey = key;
  return merged;
}

export function findSkillInstallPackageMapEntry(capabilityId: string): SkillInstallPackageMapEntry | null {
  const normalized = capabilityId.trim().toLowerCase();
  if (!normalized) return null;
  return loadSkillInstallPackageMap().entries.find((entry) => entry.patterns.some((pattern) => normalized.includes(pattern.toLowerCase()))) || null;
}

export function resetSkillInstallPackageMapCache(): void {
  cachedMap = null;
  cachedKey = null;
}
