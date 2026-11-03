import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';

/** Security policy paths use POSIX separators, including on Windows. */
function normalizePolicyPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  let end = normalized.length;
  while (end > 0 && normalized.charCodeAt(end - 1) === 47) end -= 1;
  return normalized.slice(0, end);
}

/**
 * Repo-relative spelling for policy checks. The process root wins first —
 * resolved lazily through the pathResolver namespace so fixtures that stub
 * `pathResolver.rootDir()` keep working, with a cwd fallback for the
 * secure-io -> audit-chain -> tier-guard bootstrap cycle. Only a genuinely
 * outside-root path may instead name shared authority state under the
 * primary checkout — the one store per repository — which keeps its
 * canonical repo-relative form.
 */
export function policyRelativePath(resolvedPath: string): string {
  let root: string;
  try {
    root = pathResolver.rootDir();
  } catch {
    root = process.cwd();
  }
  const rel = normalizePolicyPath(path.relative(root, resolvedPath));
  if (rel && rel !== '..' && !rel.startsWith('../')) return rel;
  const primary = pathResolver.primaryCheckoutRootDir();
  if (primary !== root) {
    const relPrimary = normalizePolicyPath(path.relative(primary, path.resolve(resolvedPath)));
    if (pathResolver.isAuthorityStoreRelativePath(relPrimary)) return relPrimary;
  }
  return rel;
}
