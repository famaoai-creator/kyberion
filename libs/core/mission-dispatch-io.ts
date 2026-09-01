import { appendJsonLine as appendFoundationJsonLine } from './foundation/json.js';
import * as nodePath from 'node:path';
import { assertSafeRepositoryPath, safeMkdir, safeExistsSync, safeWriteFile } from './secure-io.js';
import { readJsonIfPresent } from './foundation/json.js';
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

export function readJsonFile<T>(filePath: string): T | null {
  return readJsonIfPresent<T>(assertSafeRepositoryPath(filePath, { allowMissingLeaf: true }));
}

export function writeJsonFile(filePath: string, payload: unknown): void {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const dir = nodePath.dirname(safeFilePath);
  ensureDirectory(dir);
  withExecutionContext(
    'mission_controller',
    () => {
      safeWriteFile(safeFilePath, JSON.stringify(payload, null, 2));
    },
    'worker'
  );
}

export function appendJsonLine(filePath: string, payload: Record<string, unknown>): void {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
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
