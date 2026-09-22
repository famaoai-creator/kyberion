import path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { normalizeScopedReadPath } from '../../../lib/scoped-read-path';

export function isAllowedKnowledgeRefPath(logicalPath: string): boolean {
  const normalized = normalizeScopedReadPath(logicalPath);
  if (!normalized) return false;
  if (!/^knowledge\/(personal|confidential|public)\/.+\.(md|json)$/i.test(normalized)) {
    return false;
  }
  const resolved = path.resolve(pathResolver.resolve(normalized));
  const allowedRoot = path.resolve(pathResolver.resolve('knowledge'));
  return resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${path.sep}`);
}

export function resolveSafeKnowledgeReferencePath(logicalPath: string): string | null {
  const normalized = normalizeScopedReadPath(logicalPath);
  if (!normalized || !isAllowedKnowledgeRefPath(normalized)) return null;
  try {
    const resolved = assertSafeRepositoryPath(pathResolver.resolve(normalized), {
      allowMissingLeaf: true,
    });
    return safeExistsSync(resolved) && safeLstat(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}
