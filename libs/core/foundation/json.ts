import {
  loadJson,
  loadJsonIfPresent,
  safeAppendFileSync,
  safeExistsSync,
  safeReadFile,
  safeWriteFile,
} from '../secure-io.js';

export { loadJsonIfPresent };

export function readJson<T>(filePath: string): T {
  return loadJson<T>(filePath);
}

export function readJsonIfPresent<T>(filePath: string): T | null {
  return loadJsonIfPresent<T>(filePath);
}

export function writeJson<T>(filePath: string, value: T): void {
  safeWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendJsonLine<T>(filePath: string, value: T): void {
  safeAppendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

export function readJsonLines<T>(filePath: string): T[] {
  if (!safeExistsSync(filePath)) return [];
  const raw = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
