import path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { listProjectRecords, type ProjectRecord } from '@agent/core/project-registry';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { normalizeScopedReadPath } from '../../../lib/scoped-read-path';

export function isAllowedRuntimeRefPath(logicalPath: string): boolean {
  const normalized = normalizeScopedReadPath(logicalPath);
  if (!normalized) return false;
  if (!/^active\/projects\/.+\.(md|json)$/i.test(normalized)) {
    return false;
  }
  const resolved = path.resolve(pathResolver.resolve(normalized));
  const allowedRoot = path.resolve(pathResolver.active('projects'));
  return resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${path.sep}`);
}

export function resolveSafeRuntimeReferencePath(logicalPath: string): string | null {
  const normalized = normalizeScopedReadPath(logicalPath);
  if (!normalized || !isAllowedRuntimeRefPath(normalized)) return null;
  try {
    const resolved = assertSafeRepositoryPath(pathResolver.resolve(normalized), {
      allowMissingLeaf: true,
    });
    return safeExistsSync(resolved) && safeLstat(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

export type RuntimeReferenceScope = {
  tier: 'personal' | 'confidential' | 'public';
  tenantSlug?: string;
};

function isRuntimeTier(value: string | undefined): value is RuntimeReferenceScope['tier'] {
  return value === 'personal' || value === 'confidential' || value === 'public';
}

/** Resolve project-file scope from the governed path or its project registry. */
export function resolveRuntimeReferenceScope(
  logicalPath: string,
  projects: readonly ProjectRecord[] = listProjectRecords()
): RuntimeReferenceScope | null {
  const normalized = normalizeScopedReadPath(logicalPath);
  if (!normalized) return null;
  const parts = normalized.split('/');
  // The canonical layout is active/projects/{tier}/{tenantOrShared}/{project}/... .
  // A shorter active/projects/{tier}/{project}/... path is legacy and must be
  // resolved through the governed project registry instead of treating the
  // first file/directory segment as a tenant slug.
  if (
    parts[0] === 'active' &&
    parts[1] === 'projects' &&
    isRuntimeTier(parts[2]) &&
    parts.length >= 5
  ) {
    return {
      tier: parts[2],
      ...(parts[3] && parts[3] !== 'shared' ? { tenantSlug: parts[3] } : {}),
    };
  }

  const resolved = path.resolve(pathResolver.resolve(normalized));
  const project = projects.find((candidate) =>
    (candidate.repositories || []).some((repository) => {
      if (!repository.root_path) return false;
      const root = path.resolve(pathResolver.resolve(repository.root_path));
      return resolved === root || resolved.startsWith(`${root}${path.sep}`);
    })
  );
  return project
    ? {
        tier: project.tier,
        ...(project.tenant_slug ? { tenantSlug: project.tenant_slug } : {}),
      }
    : null;
}
