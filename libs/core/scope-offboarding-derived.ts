/**
 * P3 (R-09): collect a tenant's out-of-tree derived assets for offboarding.
 *
 * The tenant's derivation ledger (asset-derivation.ts) names every artifact
 * derived from its assets; paths already covered by a collected tree or
 * already propagation-deleted are skipped. Every recorded path is re-checked
 * against the same ceiling the write path enforces (derivable location,
 * the record's own source-custodian set, existing regular file) — a
 * tampered or stale ledger line is skipped with a warning, never silently
 * deleted. A missing or empty ledger contributes nothing (pre-P3
 * behaviour preserved).
 */
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeLstat } from './secure-io.js';
import { logger } from './core.js';
import {
  deletedDerivedPaths,
  isDerivableRepoPath,
  listDerivedRecordsForCustodian,
  recordedLandingHonored,
} from './asset-derivation.js';

interface DerivedAssetTarget {
  path: string;
  kind: 'derived_asset';
}

export function collectDerivedAssetTargets(
  tenantSlug: string,
  collected: readonly { path: string; kind: string }[]
): DerivedAssetTarget[] {
  const custody = { kind: 'tenant' as const, ref: tenantSlug };
  const options = { rootDir: pathResolver.rootDir() };
  const alreadyDeleted = deletedDerivedPaths(custody, options);
  const covered = (relPath: string): boolean =>
    collected.some((target) => relPath === target.path || relPath.startsWith(`${target.path}/`));
  const targets: DerivedAssetTarget[] = [];
  const seen = new Set<string>();
  for (const record of listDerivedRecordsForCustodian(custody, options)) {
    const relPath = path.posix.normalize(record.derived.path).replace(/\/+$/u, '');
    if (seen.has(relPath) || alreadyDeleted.has(relPath) || covered(relPath)) continue;
    seen.add(relPath);
    const absolute = pathResolver.rootResolve(relPath);
    const reject = (why: string): void => {
      logger.warn(
        `[scope-offboarding] skipped recorded derived path '${relPath}' for tenant '${tenantSlug}' — ${why}`
      );
    };
    // Partition-bounded honoring: a record in THIS tenant's ledger only
    // authorizes a landing when the tenant is among the record's VERIFIED
    // source custodies and the landing sits in this tenant's space (or
    // system space) at a tier that clears the verified taint floor — a
    // forged line claiming foreign custody reaches nothing.
    if (!recordedLandingHonored(record, custody, relPath, options)) {
      reject('recorded lineage fails partition-bounded replay');
      continue;
    }
    if (!isDerivableRepoPath(relPath)) {
      reject('recorded lineage reaches outside derivable data locations');
      continue;
    }
    let stat;
    try {
      if (!safeExistsSync(absolute)) {
        reject('recorded path no longer exists');
        continue;
      }
      stat = safeLstat(absolute);
    } catch {
      reject('recorded path cannot be inspected');
      continue;
    }
    if (!stat.isFile()) {
      reject('recorded path is not a regular file');
      continue;
    }
    targets.push({ path: relPath, kind: 'derived_asset' });
  }
  return targets;
}
