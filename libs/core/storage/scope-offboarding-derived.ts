import type { OffboardScopeType } from './scope-offboarding.js';
/** Guard the exact regular-file generation selected by authoritative lineage. */
import { createHash } from 'node:crypto';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { withLockSync } from '../foundation/lock-utils.js';
import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeLstat,
  safeReadFileSnapshot,
  MAX_SNAPSHOT_READ_BYTES,
  safeMkdir,
  safeWriteFile,
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

export function retainCollectedLeftovers(
  targets: readonly { path: string }[],
  removed: readonly string[],
  verification: { clean: boolean; leftovers: string[] }
): void {
  const deleted = new Set(removed);
  const remaining = targets
    .filter((target) => !deleted.has(target.path))
    .map((target) => target.path)
    .filter((relative) => {
      try {
        return safeExistsSync(pathResolver.rootResolve(relative));
      } catch {
        return true;
      }
    });
  if (remaining.length > 0) {
    verification.leftovers.push(...remaining);
    verification.clean = false;
  }
}

export function exportUnchangedDerivedTarget(target: { path: string }, exportDir: string): void {
  withLockSync(`asset-derivation-delete:${target.path}`, () => {
    const bytes = readUnchangedDerivedTarget(target);
    const destination = path.join(exportDir, ...target.path.split('/'));
    safeMkdir(path.dirname(destination), { recursive: true });
    safeWriteFile(destination, bytes);
  });
}

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

/** Bind the reviewed scope to the discovered trees and shared ledger rows. */
export function scopeOffboardPreviewId(
  scope: readonly (string | undefined)[],
  targets: readonly { kind: string; path: string }[],
  artifacts: readonly object[],
  dedup: readonly string[] = [],
  ledgers: readonly { ledger: { result_key: string }; prune: { removedLines: string[] } }[],
  traces: readonly { path: string; prune: { removedLines: string[] } }[]
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        scope,
        targets: targets.map(({ kind, path }) => [kind, path].join(':')).sort(),
        artifacts: artifacts.map((record) => JSON.stringify(record)).sort(),
        dedup: [...dedup].sort(),
        ledgers: ledgers.map(({ ledger, prune }) => [
          ledger.result_key,
          [...prune.removedLines].sort(),
        ]),
        traces: traces.map(({ path, prune }) => [path, [...prune.removedLines].sort()]).sort(),
      })
    )
    .digest('hex');
}

export interface OffboardScopeInput {
  scopeType: OffboardScopeType;
  scopeId: string;
  /** Optional tenant lineage for a project with a reused project ID. */
  tenantSlug?: string;
  /** Optional organization lineage for a project with a reused project ID. */
  organizationId?: string;
  /** `dry_run` (default) only reports; `execute` exports then deletes. */
  mode?: 'dry_run' | 'execute';
  expectedPreviewId?: string;
  approval?: OffboardApproval;
  /** Clock override for deterministic export directory names in tests. */
  nowIso?: string;
}

export interface OffboardApproval {
  approved_by: string;
  purpose: string;
  /** ISO-8601; stamped at execution time when the caller omits it. */
  approved_at?: string;
}
