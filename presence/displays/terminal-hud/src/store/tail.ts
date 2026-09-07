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
export function tailLines(filePath: string, maxLines: number): string[] {
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return [];
    const { buffer, truncated } = safeReadFileTail(safePath, MAX_TAIL_BYTES);
    let content = buffer.toString('utf8');
    if (truncated) {
      // The read started mid-file; the text before the first newline is a
      // torn fragment of whatever line straddled the cut point, not a real
      // line — drop it rather than surface a corrupted partial line.
      const firstNewline = content.indexOf('\n');
      content = firstNewline === -1 ? '' : content.slice(firstNewline + 1);
    }
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
      const value = parse(parseSafeJsonInput(line, 'terminal HUD JSONL entry'));
      if (value !== null) parsed.push(value);
    } catch {
      // skip malformed lines; append-only JSONL may have a partial last line
    }
  }
  return parsed;
}
