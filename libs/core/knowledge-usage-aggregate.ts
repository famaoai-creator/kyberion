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

export interface KnowledgeUsageAggregateEntry {
  document_path: string;
  scope_context_key?: string;
  delivered_count: number;
  used_count: number;
  not_used_count: number;
  occurrences: number;
  last_seen: string;
}

const KNOWLEDGE_USAGE_AGGREGATE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/knowledge-usage-aggregate.schema.json'
);

function usageAggregateCatalogAtPath(filePath: string) {
  return defineCatalog<KnowledgeUsageAggregateEntry[]>({
    id: 'knowledge-usage-aggregate',
    path: filePath,
    schema: KNOWLEDGE_USAGE_AGGREGATE_SCHEMA_PATH,
  });
}

/** Load the aggregate through the canonical schema and resource boundary. */
export function loadKnowledgeUsageAggregateAtPath(
  filePath: string
): KnowledgeUsageAggregateEntry[] {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath)) return [];
  if (!safeLstat(safePath).isFile()) {
    throw new Error(`[KNOWLEDGE_USAGE] aggregate must be a regular file: ${filePath}`);
  }
  return usageAggregateCatalogAtPath(safePath).load();
}

/** Validate and persist the aggregate using the same contract as the reader. */
export function writeKnowledgeUsageAggregateAtPath(
  filePath: string,
  entries: KnowledgeUsageAggregateEntry[]
): KnowledgeUsageAggregateEntry[] {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (safeExistsSync(safePath) && !safeLstat(safePath).isFile()) {
    throw new Error(`[KNOWLEDGE_USAGE] aggregate must be a regular file: ${filePath}`);
  }
  const validated = usageAggregateCatalogAtPath(safePath).validate(entries, safePath);
  safeMkdir(path.dirname(safePath), { recursive: true });
  safeWriteFile(safePath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8' });
  return validated;
}
