/** Canonical governed artifact addressing and read boundary, without writer/task imports. */
import { readJson } from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '../secure-io.js';

export function isGovernedArtifactPath(logicalPath: string): boolean {
  if (logicalPath.startsWith('active/shared/coordination/')) return true;
  if (logicalPath.startsWith('active/shared/observability/')) return true;
  if (logicalPath.startsWith('active/shared/runtime/')) return true;
  if (logicalPath.startsWith('active/missions/') && logicalPath.includes('/coordination/'))
    return true;
  if (logicalPath.startsWith('active/missions/') && logicalPath.includes('/observability/'))
    return true;
  return false;
}

export function resolveGovernedArtifactPath(logicalPath: string): string {
  if (!isGovernedArtifactPath(logicalPath)) {
    throw new Error(
      `Artifact path is outside governed coordination/observability scopes: ${logicalPath}`
    );
  }
  return assertSafeRepositoryPath(pathResolver.resolve(logicalPath), {
    allowMissingLeaf: true,
  });
}

export function ensureRegularGovernedArtifactFile(filePath: string): void {
  if (safeExistsSync(filePath) && !safeLstat(filePath).isFile()) {
    throw new Error(`governed artifact must be a regular file: ${filePath}`);
  }
}

export function readGovernedArtifactJson<T>(logicalPath: string): T | null {
  const resolved = resolveGovernedArtifactPath(logicalPath);
  if (!safeExistsSync(resolved)) return null;
  ensureRegularGovernedArtifactFile(resolved);
  return readJson<T>(resolved);
}
