import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';

export type KnowledgeTaxonomyAuthority =
  'policy' | 'standard' | 'recipe' | 'reference' | 'advisory';
export type KnowledgeTaxonomyScope = 'global' | 'repository' | 'mission' | 'environment';

export interface KnowledgeTaxonomyKind {
  description: string;
  default_authority: KnowledgeTaxonomyAuthority;
  default_scope: KnowledgeTaxonomyScope;
}

export interface KnowledgeTaxonomyDirectoryDefault {
  path_prefix: string;
  kind: string;
  authority: string;
  scope: string;
}

export interface KnowledgeTaxonomy {
  version: string;
  default_tier_inference?: Record<string, 'public' | 'confidential' | 'personal'>;
  kinds: Record<string, KnowledgeTaxonomyKind>;
  directory_defaults: KnowledgeTaxonomyDirectoryDefault[];
  overlay_precedence: KnowledgeTaxonomyScope[];
  retrieval_priority: Record<string, string[]>;
}

const KNOWLEDGE_TAXONOMY_PATH = pathResolver.knowledge(
  'product/governance/knowledge-taxonomy.json'
);
const KNOWLEDGE_TAXONOMY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/knowledge-taxonomy.schema.json'
);

function knowledgeTaxonomyCatalogAtPath(filePath: string) {
  return defineCatalog<KnowledgeTaxonomy>({
    id: 'knowledge-taxonomy',
    path: filePath,
    schema: KNOWLEDGE_TAXONOMY_SCHEMA_PATH,
  });
}

/** Load the repository taxonomy through the canonical schema and path boundary. */
export function loadKnowledgeTaxonomy(): KnowledgeTaxonomy {
  return loadKnowledgeTaxonomyAtPath(KNOWLEDGE_TAXONOMY_PATH);
}

/** Load a taxonomy override only after repository and regular-file checks. */
export function loadKnowledgeTaxonomyAtPath(filePath: string): KnowledgeTaxonomy {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) {
    throw new Error(`[KNOWLEDGE_TAXONOMY] taxonomy must be a regular file: ${filePath}`);
  }
  return knowledgeTaxonomyCatalogAtPath(safePath).load();
}
