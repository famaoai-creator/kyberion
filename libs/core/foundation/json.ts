// A direct foundation import must install the governed secure-io bridge before
// the first catalog read. secure-io no longer imports this module, so this
// bootstrap is intentionally one-way and does not create an import cycle.
import '../secure-io.js';
import { getFoundationIo, type FoundationReadOptions } from './io.js';
import { readTextFile } from './text.js';
export {
  parseSafeJsonInput,
  parseSafeJsonEntriesInput,
  parseSafeJsonObjectInput,
  parseSafeJsonObjectValue,
  parsePersistedPipelineStrategy,
  readJsonObjectRequest,
  type JsonObjectRequest,
  type JsonObjectRequestResult,
  type PersistedPipelineStep,
  type PersistedPipelineStrategyConfig,
} from './safe-json.js';
import { parseSafeJsonInput } from './safe-json.js';

export function loadJson<T>(filePath: string, options?: FoundationReadOptions): T {
  return getFoundationIo().loadJson<T>(filePath, options);
}

export function loadJsonIfPresent<T>(filePath: string, options?: FoundationReadOptions): T | null {
  return getFoundationIo().loadJsonIfPresent<T>(filePath, options);
}

export function readJson<T>(filePath: string, options?: FoundationReadOptions): T {
  return getFoundationIo().loadJson<T>(filePath, options);
}

export function readJsonIfPresent<T>(filePath: string, options?: FoundationReadOptions): T | null {
  return loadJsonIfPresent<T>(filePath, options);
}

export function writeJson<T>(filePath: string, value: T): void {
  getFoundationIo().writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendJsonLine<T>(filePath: string, value: T): void {
  getFoundationIo().appendFile(filePath, `${JSON.stringify(value)}\n`);
}

export interface ReadJsonLinesOptions<T> {
  /** Replay policy for malformed JSON or mapper failures. */
  onMalformed?: 'throw' | 'skip' | ((error: unknown, lineNumber: number) => void);
  /** Optional domain parser. The second argument is the one-based line number. */
  map?: (value: unknown, lineNumber: number) => T;
  /** Options forwarded to the governed text reader for the whole JSONL file. */
  readOptions?: FoundationReadOptions;
}

export function readJsonLines<T>(filePath: string, options: ReadJsonLinesOptions<T> = {}): T[] {
  if (!getFoundationIo().exists(filePath)) return [];
  const raw = readTextFile(filePath, options.readOptions);
  const records: T[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const value = parseSafeJsonInput(line, `JSONL entry ${index + 1}`);
      records.push(options.map ? options.map(value, index + 1) : (value as T));
    } catch (error) {
      if (typeof options.onMalformed === 'function') {
        options.onMalformed(error, index + 1);
        continue;
      }
      if (options.onMalformed === 'skip') continue;
      throw error;
    }
  }
  return records;
}
