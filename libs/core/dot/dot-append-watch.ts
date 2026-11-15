import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, MAX_RANGE_READ_BYTES, safeReadFileRange } from '../secure-io.js';

/**
 * True when every appended record since the last snapshot is an ignored kind —
 * the file changed only on rows the charter asked to skip (e.g. the
 * undelivered-notification rows an unwired notify lane keeps producing), so the
 * watch must not fire. Any blank, malformed or non-ignored line fails open.
 */
export function watchAppendOnlyIgnoredKinds(
  rel: string,
  fromSize: number,
  toSize: number,
  ignored: readonly string[],
  rootDir?: string
): boolean {
  const appended = toSize - fromSize;
  if (appended <= 0 || appended > MAX_RANGE_READ_BYTES) return false;
  try {
    const safe = assertSafeRepositoryPath(path.join(rootDir ?? pathResolver.rootDir(), rel), {
      allowMissingLeaf: true,
    });
    const tail = safeReadFileRange(safe, fromSize, appended).toString('utf8');
    const lines = tail.split('\n');
    // A trailing unterminated fragment is the next line in progress; dropping
    // it here means it is re-evaluated once it is complete and flushed.
    if (!tail.endsWith('\n')) lines.pop();
    const records = lines.filter((line) => line.trim().length > 0);
    if (records.length === 0) return true;
    return records.every((line) => {
      try {
        const record: unknown = JSON.parse(line);
        return (
          typeof record === 'object' &&
          record !== null &&
          ignored.includes(String((record as { kind?: unknown }).kind))
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
