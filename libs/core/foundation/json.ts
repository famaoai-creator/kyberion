// A direct foundation import must install the governed secure-io bridge before
// the first catalog read. secure-io no longer imports this module, so this
// bootstrap is intentionally one-way and does not create an import cycle.
import '../secure-io.js';
import { getFoundationIo } from './io.js';

export function loadJson<T>(filePath: string): T {
  return getFoundationIo().loadJson<T>(filePath);
}

export function loadJsonIfPresent<T>(filePath: string): T | null {
  return getFoundationIo().loadJsonIfPresent<T>(filePath);
}

export function readJson<T>(filePath: string): T {
  return getFoundationIo().loadJson<T>(filePath);
}

export function readJsonIfPresent<T>(filePath: string): T | null {
  return loadJsonIfPresent<T>(filePath);
}

export function writeJson<T>(filePath: string, value: T): void {
  getFoundationIo().writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendJsonLine<T>(filePath: string, value: T): void {
  getFoundationIo().appendFile(filePath, `${JSON.stringify(value)}\n`);
}

export function readJsonLines<T>(filePath: string): T[] {
  if (!getFoundationIo().exists(filePath)) return [];
  const raw = getFoundationIo().readFile(filePath);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
