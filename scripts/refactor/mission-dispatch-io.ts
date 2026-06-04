import * as nodePath from 'node:path';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  withExecutionContext,
} from '@agent/core';

export function countWords(value: string): number {
  return String(value || '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean).length;
}

export function ensureDirectory(dirPath: string): void {
  withExecutionContext('mission_controller', () => {
    if (!safeExistsSync(dirPath)) safeMkdir(dirPath, { recursive: true });
  }, 'worker');
}

export function readJsonFile<T>(filePath: string): T | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
  } catch (_) {
    return null;
  }
}

export function writeJsonFile(filePath: string, payload: unknown): void {
  const dir = nodePath.dirname(filePath);
  ensureDirectory(dir);
  withExecutionContext('mission_controller', () => {
    safeWriteFile(filePath, JSON.stringify(payload, null, 2));
  }, 'worker');
}

export function appendJsonLine(filePath: string, payload: Record<string, unknown>): void {
  const dir = nodePath.dirname(filePath);
  ensureDirectory(dir);
  withExecutionContext('mission_controller', () => {
    safeAppendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  }, 'worker');
}
