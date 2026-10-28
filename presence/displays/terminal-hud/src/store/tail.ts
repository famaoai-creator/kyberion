import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFileTail,
} from '@agent/core/secure-io';
import { parseSafeJsonInput } from '@agent/core/foundation';

export const MAX_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * Bounded tail of a (possibly large) line-oriented file: reads at most the
 * last `MAX_TAIL_BYTES` bytes (never the whole file) via `safeReadFileTail`,
 * drops a leading partial line when the read was truncated (the byte cut
 * point rarely lands on a line boundary), and returns at most `maxLines`
 * complete trailing lines.
 */
export interface TailRead<T> {
  records: T[];
  truncated: boolean;
  omittedLines: number;
  skippedLines: number;
  status: 'ok' | 'missing' | 'unavailable';
}

export function readTailLines(filePath: string, maxLines: number): TailRead<string> {
  const empty: TailRead<string> = {
    records: [],
    truncated: false,
    omittedLines: 0,
    skippedLines: 0,
    status: 'ok',
  };
  if (!Number.isSafeInteger(maxLines) || maxLines <= 0)
    throw new Error('maxLines must be a positive integer');
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath)) return { ...empty, status: 'missing' };
    if (!safeLstat(safePath).isFile()) return { ...empty, status: 'unavailable' };
    const { buffer, truncated } = safeReadFileTail(safePath, MAX_TAIL_BYTES);
    let content = buffer.toString('utf8');
    if (truncated) {
      const firstNewline = content.indexOf('\n');
      content = firstNewline === -1 ? '' : content.slice(firstNewline + 1);
    }
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    return {
      ...empty,
      records: lines.slice(-maxLines),
      truncated,
      omittedLines: Math.max(0, lines.length - maxLines),
    };
  } catch {
    // Error strings may contain private paths or rejected content; only expose disposition.
    return { ...empty, status: 'unavailable' };
  }
}

/** Compatibility facade for callers that only need records. */
export function tailLines(filePath: string, maxLines: number): string[] {
  return readTailLines(filePath, maxLines).records;
}

export type JsonlParser<T> = (value: unknown) => T | null;

export function readTailJsonl<T>(
  filePath: string,
  maxLines: number,
  parse: JsonlParser<T>
): TailRead<T> {
  const read = readTailLines(filePath, maxLines);
  const records: T[] = [];
  let skippedLines = 0;
  for (const line of read.records) {
    try {
      const value = parse(parseSafeJsonInput(line, 'terminal HUD JSONL entry'));
      if (value !== null) records.push(value);
      else skippedLines++;
    } catch {
      skippedLines++;
    }
  }
  return { ...read, records, skippedLines };
}

export function tailJsonl<T>(filePath: string, maxLines: number, parse: JsonlParser<T>): T[] {
  return readTailJsonl(filePath, maxLines, parse).records;
}
