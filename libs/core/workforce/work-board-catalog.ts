/** Work-board catalog loading through the shared schema boundary (split from work-coordination.ts). */
import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeLstat } from '../secure-io.js';
import type { WorkBoardCatalog } from './work-coordination-types.js';

const WORK_BOARD_CATALOG_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/work-board-catalog.schema.json'
);

export function workBoardCatalogAtPath(filePath: string) {
  return defineCatalog<WorkBoardCatalog>({
    id: 'work-board-catalog',
    path: filePath,
    schema: WORK_BOARD_CATALOG_SCHEMA_PATH,
  });
}

/** Load the persisted work-board catalog through the shared schema boundary. */
export function loadWorkBoardCatalogAtPath(filePath: string): WorkBoardCatalog {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[WORK_BOARD_CATALOG] catalog must be a regular file: ${filePath}`);
  }
  return workBoardCatalogAtPath(safeFilePath).load();
}
