import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { knowledge } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';

interface KnowledgeScopeHealthHistory {
  generated_at: string;
  legacy_unscoped_file_count: number;
}

const HISTORY_SCHEMA_PATH = knowledge('product/schemas/knowledge-scope-health-history.schema.json');

function historyCatalog(filePath: string) {
  return defineCatalog<KnowledgeScopeHealthHistory>({
    id: 'knowledge-scope-health-history',
    path: filePath,
    schema: HISTORY_SCHEMA_PATH,
  });
}

export function readKnowledgeScopeHealthCount(filePath: string): number | undefined {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeFilePath)) return undefined;
  try {
    if (!safeLstat(safeFilePath).isFile()) return undefined;
    return historyCatalog(safeFilePath).load().legacy_unscoped_file_count;
  } catch {
    return undefined;
  }
}

export function writeKnowledgeScopeHealthCount(
  filePath: string,
  count: number,
  generatedAt: string
): void {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (safeExistsSync(safeFilePath) && !safeLstat(safeFilePath).isFile()) {
    throw new Error(`Knowledge scope health history must be a regular file: ${safeFilePath}`);
  }
  const history = historyCatalog(safeFilePath).validate(
    { generated_at: generatedAt, legacy_unscoped_file_count: count },
    safeFilePath
  );
  safeMkdir(path.dirname(safeFilePath), { recursive: true });
  safeWriteFile(safeFilePath, `${JSON.stringify(history, null, 2)}\n`, { encoding: 'utf8' });
}
