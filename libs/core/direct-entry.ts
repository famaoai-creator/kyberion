import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Return whether a module was invoked directly as the expected source or build entrypoint. */
export function isDirectEntry(
  importMetaUrl: string,
  expectedFile: string,
  entryPath = process.argv[1]
): boolean {
  if (!entryPath) return false;

  const normalizePath = (value: string): string => {
    const normalized = path.resolve(value).replaceAll('\\', '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const actual = normalizePath(entryPath);
  const modulePath = normalizePath(fileURLToPath(importMetaUrl));
  const expected = expectedFile.replaceAll('\\', '/').replace(/^\.\//u, '');
  const candidates = [expected, expected.replace(/\.ts$/u, '.js')];
  return actual === modulePath && candidates.some((candidate) => actual.endsWith(candidate));
}
