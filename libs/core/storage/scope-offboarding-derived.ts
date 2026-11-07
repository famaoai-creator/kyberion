/** Guard the exact regular-file generation selected by authoritative lineage. */
import { createHash } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeLstat,
  safeReadFileSnapshot,
  MAX_SNAPSHOT_READ_BYTES,
} from '../secure-io.js';
import { listHonoredDerivedPathsForCustodian } from '../information-assets/asset-derivation.js';

interface DerivedAssetTarget {
  path: string;
  kind: 'derived_asset';
}
interface FileGeneration {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  sha256: string;
}
// Keep execution guards private; exported manifests remain stable path/kind records.
const generations = new WeakMap<object, FileGeneration>();

function snapshot(relative: string): { generation: FileGeneration; bytes: Buffer } {
  const absolute = pathResolver.rootResolve(relative);
  const before = safeLstat(absolute);
  if (!before.isFile() || before.nlink !== 1)
    throw new Error(`[OFFBOARD_DERIVED_CHANGED] Not a single-link regular file: ${relative}`);
  const bytes = safeReadFileSnapshot(absolute, MAX_SNAPSHOT_READ_BYTES);
  const after = safeLstat(absolute);
  const identity = (stat: typeof before) => ({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
  if (
    !after.isFile() ||
    after.nlink !== 1 ||
    JSON.stringify(identity(before)) !== JSON.stringify(identity(after))
  )
    throw new Error(`[OFFBOARD_DERIVED_CHANGED] File changed during capture: ${relative}`);
  return {
    generation: { ...identity(after), sha256: createHash('sha256').update(bytes).digest('hex') },
    bytes,
  };
}

/** Revalidate immediately at use; cooperative locks cannot fence arbitrary external writers. */
export function readUnchangedDerivedTarget(target: { path: string }): Buffer {
  const expected = generations.get(target);
  const current = snapshot(target.path);
  if (!expected || JSON.stringify(expected) !== JSON.stringify(current.generation))
    throw new Error(`[OFFBOARD_DERIVED_CHANGED] Refusing changed derived file: ${target.path}`);
  return current.bytes;
}

export function collectDerivedAssetTargets(
  tenantSlug: string,
  collected: readonly { path: string; kind: string }[]
): DerivedAssetTarget[] {
  const paths = listHonoredDerivedPathsForCustodian(
    { kind: 'tenant', ref: tenantSlug },
    { rootDir: pathResolver.rootDir() }
  );
  const targets: DerivedAssetTarget[] = [];
  for (const relative of paths) {
    if (
      collected.some((target) => relative === target.path || relative.startsWith(`${target.path}/`))
    )
      continue;
    // A historical path-only tombstone never suppresses a recreated file.
    if (!safeExistsSync(pathResolver.rootResolve(relative))) continue;
    const target: DerivedAssetTarget = { path: relative, kind: 'derived_asset' };
    generations.set(target, snapshot(relative).generation);
    targets.push(target);
  }
  return targets;
}
