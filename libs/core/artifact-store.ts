import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeWriteFile,
} from './secure-io.js';

export type GovernedArtifactRole =
  | 'slack_bridge'
  | 'chronos_gateway'
  | 'surface_runtime'
  | 'mission_controller'
  | 'infrastructure_sentinel'
  | 'sovereign_concierge';

function withRole<T>(role: GovernedArtifactRole, fn: () => T): T {
  return withExecutionContext(role, fn);
}

export function isGovernedArtifactPath(logicalPath: string): boolean {
  if (logicalPath.startsWith('active/shared/coordination/')) return true;
  if (logicalPath.startsWith('active/shared/observability/')) return true;
  if (logicalPath.startsWith('active/shared/runtime/')) return true;
  if (logicalPath.startsWith('active/missions/') && logicalPath.includes('/coordination/')) return true;
  if (logicalPath.startsWith('active/missions/') && logicalPath.includes('/observability/')) return true;
  return false;
}

export function resolveGovernedArtifactPath(logicalPath: string): string {
  if (!isGovernedArtifactPath(logicalPath)) {
    throw new Error(`Artifact path is outside governed coordination/observability scopes: ${logicalPath}`);
  }
  return pathResolver.resolve(logicalPath);
}

export function ensureGovernedArtifactDir(role: GovernedArtifactRole, logicalDir: string): string {
  return withRole(role, () => {
    const resolved = resolveGovernedArtifactPath(logicalDir);
    if (!safeExistsSync(resolved)) safeMkdir(resolved, { recursive: true });
    return resolved;
  });
}

export function writeGovernedArtifactJson(role: GovernedArtifactRole, logicalPath: string, value: unknown): string {
  return withRole(role, () => {
    const resolved = resolveGovernedArtifactPath(logicalPath);
    const dir = path.dirname(resolved);
    if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
    safeWriteFile(logicalPath, JSON.stringify(value, null, 2));
    return resolved;
  });
}

export function appendGovernedArtifactJsonl(role: GovernedArtifactRole, logicalPath: string, value: unknown): string {
  return withRole(role, () => {
    const resolved = resolveGovernedArtifactPath(logicalPath);
    const dir = path.dirname(resolved);
    if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
    safeAppendFileSync(logicalPath, JSON.stringify(value) + '\n', 'utf8');
    return resolved;
  });
}

export function readGovernedArtifactJson<T>(logicalPath: string): T | null {
  const resolved = resolveGovernedArtifactPath(logicalPath);
  if (!safeExistsSync(resolved)) return null;
  return JSON.parse(safeReadFile(resolved, { encoding: 'utf8' }) as string) as T;
}

export function listGovernedArtifacts(logicalDir: string): string[] {
  const resolved = resolveGovernedArtifactPath(logicalDir);
  if (!safeExistsSync(resolved)) return [];
  return safeReaddir(resolved).sort();
}
