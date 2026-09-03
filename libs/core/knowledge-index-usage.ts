import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';

export type KnowledgeIndexUsageMap = Record<string, string>;

const KNOWLEDGE_INDEX_USAGE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/knowledge-index-usage.schema.json'
);

function usageCatalogAtPath(filePath: string) {
  return defineCatalog<KnowledgeIndexUsageMap>({
    id: 'knowledge-index-usage',
    path: filePath,
    schema: KNOWLEDGE_INDEX_USAGE_SCHEMA_PATH,
    fallback: {},
    fallbackOnInvalid: true,
  });
}

/** Load the optional cache usage sidecar through the shared catalog boundary. */
export function loadKnowledgeIndexUsageAtPath(filePath: string): KnowledgeIndexUsageMap {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return {};
  return usageCatalogAtPath(safePath).load();
}

/** Validate and persist the cache usage sidecar using the same contract. */
export function writeKnowledgeIndexUsageAtPath(
  filePath: string,
  usage: KnowledgeIndexUsageMap
): KnowledgeIndexUsageMap {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (safeExistsSync(safePath) && !safeLstat(safePath).isFile()) {
    throw new Error(`[KNOWLEDGE_INDEX_USAGE] usage must be a regular file: ${filePath}`);
  }
  const validated = usageCatalogAtPath(safePath).validate(usage, safePath);
  safeMkdir(path.dirname(safePath), { recursive: true });
  safeWriteFile(safePath, `${JSON.stringify(validated)}\n`, { encoding: 'utf8' });
  return validated;
}
