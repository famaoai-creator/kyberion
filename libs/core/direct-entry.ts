import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Return whether a module was invoked directly as the expected source or build entrypoint. */
export function isDirectEntry(
  importMetaUrl: string,
  expectedFile: string,
  entryPath = process.argv[1]
): boolean {
  if (!entryPath) return false;

  const actual = path.resolve(entryPath);
  const modulePath = path.resolve(fileURLToPath(importMetaUrl));
  const expected = expectedFile.replaceAll('\\', '/').replace(/^\.\//u, '');
  const candidates = [expected, expected.replace(/\.ts$/u, '.js')];
  return actual === modulePath && candidates.some((candidate) => actual.endsWith(candidate));
}
