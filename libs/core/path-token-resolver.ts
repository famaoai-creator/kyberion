import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath } from './secure-io.js';

type PathTokenDomain = 'root' | 'knowledge' | 'active' | 'shared' | 'tmp' | 'vault';

function resolveDomainPath(
  domain: PathTokenDomain,
  basePath: string,
  subPath: string,
  token: string
): string {
  const base = path.resolve(basePath);
  const candidate = subPath ? path.resolve(base, subPath) : base;
  const relative = path.relative(base, candidate).replaceAll('\\', '/');
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`[RESOURCE_PATH_SCOPE] path token escapes its ${domain} domain: ${token}`);
  }

  // assertSafeRepositoryPath intentionally rejects the repository root itself.
  // The root token without a subpath is the one valid exception.
  if (candidate === path.resolve(pathResolver.rootDir())) return candidate;
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
}

/**
 * Resolve an inline repository path token while preserving domain confinement.
 * The result is an absolute runtime path and must not be persisted.
 */
export function resolveRepositoryPathToken(token: string): string | undefined {
  const trimmed = token.slice(1).trim();
  const sepIdx = trimmed.indexOf(':');
  const domain = (sepIdx >= 0 ? trimmed.slice(0, sepIdx) : trimmed).trim();
  const subPath = sepIdx >= 0 ? trimmed.slice(sepIdx + 1).trim() : '';

  switch (domain) {
    case 'root':
      return resolveDomainPath(domain, pathResolver.rootDir(), subPath, token);
    case 'knowledge':
      return resolveDomainPath(domain, pathResolver.knowledge(), subPath, token);
    case 'active':
      return resolveDomainPath(domain, pathResolver.active(), subPath, token);
    case 'shared':
      return resolveDomainPath(domain, pathResolver.shared(), subPath, token);
    case 'tmp':
      return resolveDomainPath(domain, pathResolver.shared('tmp'), subPath, token);
    case 'vault':
      return resolveDomainPath(domain, pathResolver.vault(), subPath, token);
    default:
      return undefined;
  }
}
