import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';

export interface DocumentationSourceMapScopedSource {
  scope: string;
  path: string;
}

export interface DocumentationSourceMapCategory {
  id: string;
  canonical: string;
  canonical_scope?: string;
  index?: string;
  supporting?: string[];
  historical?: string[];
  scoped_sources?: DocumentationSourceMapScopedSource[];
}

export interface DocumentationSourceMap {
  manifest_version: 1;
  last_reviewed?: string;
  purpose?: string;
  categories: DocumentationSourceMapCategory[];
  entrypoints: string[];
}

const DOCUMENTATION_SOURCE_MAP_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/documentation-source-map.schema.json'
);

export function loadDocumentationSourceMapAtPath(
  filePath = pathResolver.rootResolve('docs/documentation-source-map.json')
): DocumentationSourceMap {
  return defineCatalog<DocumentationSourceMap>({
    id: 'documentation-source-map',
    path: filePath,
    schema: DOCUMENTATION_SOURCE_MAP_SCHEMA_PATH,
  }).load();
}
