import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';

export type SurfaceRoleWriteMode = 'full' | 'scoped' | 'none' | 'orchestrator';

export interface SurfaceRoleCatalogEntry {
  id: string;
  name_ja: string;
  name_en: string;
  role_ja: string;
  tagline_ja: string;
  metaphor: string;
  dir: string;
  port: number;
  writes: SurfaceRoleWriteMode;
  tagline_key?: string;
  enabled?: boolean;
}

export interface SurfaceRoleCatalog {
  version: string;
  description?: string;
  roles: SurfaceRoleCatalogEntry[];
}

const catalog = defineCatalog<SurfaceRoleCatalog>({
  id: 'surface-roles',
  path: () => pathResolver.knowledge('product/governance/surface-roles.json'),
  schema: pathResolver.knowledge('product/schemas/surface-roles.schema.json'),
});

export function loadSurfaceRoleCatalog(): SurfaceRoleCatalog {
  return catalog.load();
}
