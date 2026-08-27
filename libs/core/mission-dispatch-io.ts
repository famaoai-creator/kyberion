import { appendJsonLine as appendFoundationJsonLine } from './foundation/json.js';
import * as nodePath from 'node:path';
import { safeAppendFileSync, safeMkdir, safeExistsSync, safeWriteFile } from './secure-io.js';
import { readJsonIfPresent } from './foundation/json.js';
import { withExecutionContext } from './authority.js';

export function countWords(value: string): number {
  return String(value || '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean).length;
}

export function ensureDirectory(dirPath: string): void {
  withExecutionContext(
    'mission_controller',
    () => {
      if (!safeExistsSync(dirPath)) safeMkdir(dirPath, { recursive: true });
    },
    'worker'
  );
}

export function readJsonFile<T>(filePath: string): T | null {
  return readJsonIfPresent<T>(filePath);
}

export function writeJsonFile(filePath: string, payload: unknown): void {
  const dir = nodePath.dirname(filePath);
  ensureDirectory(dir);
  withExecutionContext(
    'mission_controller',
    () => {
      safeWriteFile(filePath, JSON.stringify(payload, null, 2));
    },
    'worker'
  );
}

export function appendJsonLine(filePath: string, payload: Record<string, unknown>): void {
  const dir = nodePath.dirname(filePath);
  ensureDirectory(dir);
  withExecutionContext(
    'mission_controller',
    () => {
      appendFoundationJsonLine(filePath, payload);
    },
    'worker'
  );
}
