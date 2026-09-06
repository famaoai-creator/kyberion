import path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { loadGateManifest } from '../run_checks.js';

const ROOT = path.resolve(pathResolver.rootDir());

function resolveRepositoryPath(reference: string): string {
  if (
    path.isAbsolute(reference) ||
    reference.split(/[\\/]+/u).some((segment) => segment === '..')
  ) {
    throw new Error(`ci gate baseline must stay inside the repository: ${reference}`);
  }

  const resolved = path.resolve(pathResolver.rootResolve(reference));
  const relative = path.relative(ROOT, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`ci gate baseline must stay inside the repository: ${reference}`);
  }
  return resolved;
}

export function resolveCiGateBaselinePath(gateId: string): string {
  const baseline = loadGateManifest().gates.find((gate) => gate.id === gateId)?.baseline;
  if (!baseline) throw new Error(`ci gate ${gateId} must declare a baseline path`);
  return resolveRepositoryPath(baseline);
}

export function resolveDeclaredBaselinePath(reference: string): string {
  return resolveRepositoryPath(reference);
}
