import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import * as pathResolver from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';

export interface KnowledgeIndexCacheEntry {
  source: string;
  textHash: string;
  vector: number[];
}

export interface KnowledgeIndexCache {
  scopeHash: string;
  model: string;
  builtAt: string;
  entries: KnowledgeIndexCacheEntry[];
}

const CACHE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/knowledge-index-cache.schema.json'
);

function cacheCatalog(filePath: string) {
  return defineCatalog<KnowledgeIndexCache>({
    id: 'knowledge-index-cache',
    path: filePath,
    schema: CACHE_SCHEMA_PATH,
  });
}

export function loadKnowledgeIndexCacheAtPath(filePath: string): KnowledgeIndexCache | null {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath)) return null;
  if (!safeLstat(safePath).isFile()) return null;
  try {
    return cacheCatalog(safePath).load();
  } catch {
    return null;
  }
}

export function writeKnowledgeIndexCacheAtPath(
  filePath: string,
  cache: KnowledgeIndexCache
): KnowledgeIndexCache {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (safeExistsSync(safePath) && !safeLstat(safePath).isFile()) {
    throw new Error(`Knowledge index cache must be a regular file: ${filePath}`);
  }
  const validated = cacheCatalog(safePath).validate(cache, safePath);
  safeMkdir(path.dirname(safePath), { recursive: true });
  safeWriteFile(safePath, `${JSON.stringify(validated)}\n`, { encoding: 'utf8' });
  return validated;
}
