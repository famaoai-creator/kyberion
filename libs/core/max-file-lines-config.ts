import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';

export interface MaxFileLinesException {
  file: string;
  reason: string;
  target: string;
}

export interface MaxFileLinesConfig {
  max_lines: number;
  roots: string[];
  exceptions: MaxFileLinesException[];
}

const DEFAULT_CONFIG_PATH = 'knowledge/product/governance/max-file-lines.json';
const CONFIG_SCHEMA_PATH = pathResolver.knowledge('product/schemas/max-file-lines.schema.json');

/** Load the max-file-lines policy through the shared schema/path boundary. */
export function loadMaxFileLinesConfig(configPath = DEFAULT_CONFIG_PATH): MaxFileLinesConfig {
  const resolved = pathResolver.rootResolve(configPath);
  return defineCatalog<MaxFileLinesConfig>({
    id: 'max-file-lines-config',
    path: resolved,
    schema: CONFIG_SCHEMA_PATH,
  }).load();
}
