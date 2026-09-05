import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';

export interface SkillIndexEntry {
  n: string;
  path: string;
  d: string;
  s: 'implemented';
  version: string;
  capability_count: number;
}

export interface SkillIndexFile {
  v: string;
  t: number;
  u?: string;
  s: SkillIndexEntry[];
}

const skillIndexCatalog = defineCatalog<SkillIndexFile>({
  id: 'skill-index',
  path: pathResolver.knowledge('product/orchestration/global_skill_index.json'),
  schema: pathResolver.knowledge('product/schemas/skill-index.schema.json'),
});

export function loadSkillIndex(): SkillIndexFile {
  return skillIndexCatalog.load();
}
