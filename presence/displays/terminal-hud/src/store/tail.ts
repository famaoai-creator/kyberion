import { safeExistsSync, safeReadFile, safeStat } from '@agent/core/secure-io';

const MAX_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * Bounded tail of a (possibly large) line-oriented file: reads the file only
 * when it is under the byte cap, otherwise reports it as skipped, and returns
 * at most `maxLines` complete trailing lines.
 */
export function tailLines(filePath: string, maxLines: number): string[] {
  try {
    if (!safeExistsSync(filePath)) return [];
    const stat = safeStat(filePath);
    if (stat.size > MAX_TAIL_BYTES) {
      return [`[tail skipped: ${Math.round(stat.size / 1024 / 1024)}MB > cap]`];
    }
    const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

export function tailJsonl<T>(filePath: string, maxLines: number): T[] {
  const parsed: T[] = [];
  for (const line of tailLines(filePath, maxLines)) {
    try {
      parsed.push(JSON.parse(line) as T);
    } catch {
      // skip malformed lines; append-only JSONL may have a partial last line
    }
  }
  return parsed;
}
