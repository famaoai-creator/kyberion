import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';

export interface FrontmatterExclusionManifest {
  manifest_version: number;
  purpose: string;
  last_reviewed: string;
  excluded_paths: string[];
}

const FRONTMATTER_EXCLUSIONS_PATH = pathResolver.knowledge(
  'product/governance/frontmatter-exclusions.json'
);
const FRONTMATTER_EXCLUSIONS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/frontmatter-exclusions.schema.json'
);

function frontmatterExclusionsCatalogAtPath(filePath: string) {
  return defineCatalog<FrontmatterExclusionManifest>({
    id: 'frontmatter-exclusions',
    path: filePath,
    schema: FRONTMATTER_EXCLUSIONS_SCHEMA_PATH,
  });
}

/** Load the exclusion manifest through its schema and repository boundary. */
export function loadFrontmatterExclusionsAtPath(filePath: string): FrontmatterExclusionManifest {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath)) {
    throw new Error(`[FRONTMATTER_EXCLUSIONS] manifest is missing: ${filePath}`);
  }
  if (!safeLstat(safePath).isFile()) {
    throw new Error(`[FRONTMATTER_EXCLUSIONS] manifest must be a regular file: ${filePath}`);
  }
  return frontmatterExclusionsCatalogAtPath(safePath).load();
}

/** Load the repository's canonical frontmatter exclusion manifest. */
export function loadFrontmatterExclusions(): FrontmatterExclusionManifest {
  return loadFrontmatterExclusionsAtPath(FRONTMATTER_EXCLUSIONS_PATH);
}
