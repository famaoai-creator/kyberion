import { appendJsonLine as appendFoundationJsonLine } from './foundation/json.js';
import * as nodePath from 'node:path';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeMkdir } from './secure-io.js';
import { withExecutionContext } from './authority.js';

export function countWords(value: string): number {
  return String(value || '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean).length;
}

export function ensureDirectory(dirPath: string): void {
  const safeDirPath = assertSafeRepositoryPath(dirPath, { allowMissingLeaf: true });
  withExecutionContext(
    'mission_controller',
    () => {
      if (!safeExistsSync(safeDirPath)) safeMkdir(safeDirPath, { recursive: true });
    },
    'worker'
  );
}

export function appendJsonLine(filePath: string, payload: Record<string, unknown>): void {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (safeExistsSync(safeFilePath) && !safeLstat(safeFilePath).isFile()) {
    throw new Error(`[MISSION_DISPATCH] event log must be a regular file: ${safeFilePath}`);
  }
  const dir = nodePath.dirname(safeFilePath);
  ensureDirectory(dir);
  withExecutionContext(
    'mission_controller',
    () => {
      appendFoundationJsonLine(safeFilePath, payload);
    },
    'worker'
  );
}
