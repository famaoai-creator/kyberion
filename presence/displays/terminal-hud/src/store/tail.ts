import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFile,
} from '@agent/core/secure-io';

const MAX_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * Bounded tail of a (possibly large) line-oriented file: reads the file only
 * when it is under the byte cap, otherwise reports it as skipped, and returns
 * at most `maxLines` complete trailing lines.
 */
export function tailLines(filePath: string, maxLines: number): string[] {
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return [];
    const stat = safeLstat(safePath);
    if (stat.size > MAX_TAIL_BYTES) {
      return [`[tail skipped: ${Math.round(stat.size / 1024 / 1024)}MB > cap]`];
    }
    const content = safeReadFile(safePath, { encoding: 'utf8' }) as string;
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

export type JsonlParser<T> = (value: unknown) => T | null;

export function tailJsonl<T>(filePath: string, maxLines: number, parse: JsonlParser<T>): T[] {
  const parsed: T[] = [];
  for (const line of tailLines(filePath, maxLines)) {
    try {
      const value = parse(JSON.parse(line));
      if (value !== null) parsed.push(value);
    } catch {
      // skip malformed lines; append-only JSONL may have a partial last line
    }
  }
  return parsed;
}
