import * as path from 'node:path';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync } from './secure-io.js';

export interface MissionManagementConfig {
  version: string;
  directories: Record<string, string>;
  mep_version?: string;
  mission_control_model?: string;
  rehydrate_map?: Record<string, string>;
}

const catalogCache = new Map<string, GovernedCatalog<MissionManagementConfig>>();

function getCatalog(rootDir: string): GovernedCatalog<MissionManagementConfig> {
  const root = path.resolve(rootDir);
  const existing = catalogCache.get(root);
  if (existing) return existing;
  const catalog = defineCatalog<MissionManagementConfig>({
    id: 'mission-management-config',
    path: path.join(root, 'knowledge/product/governance/mission-management-config.json'),
    schema: path.join(root, 'knowledge/product/schemas/mission-management.schema.json'),
  });
  catalogCache.set(root, catalog);
  return catalog;
}

/** Load mission path configuration through its schema; missing or invalid config is absent. */
export function loadMissionManagementConfig(
  rootDir = pathResolver.rootDir()
): MissionManagementConfig | null {
  const root = path.resolve(rootDir);
  const configPath = path.join(root, 'knowledge/product/governance/mission-management-config.json');
  if (!safeExistsSync(configPath)) return null;
  try {
    return getCatalog(root).load();
  } catch {
    return null;
  }
}
