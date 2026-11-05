/**
 * S2 of the store-catalog guard design: move each tenant's company assets out
 * of the legacy `customer/{tenant}/` directory into the tenant home,
 * `knowledge/confidential/{tenant}/` (organization/tenant-home.ts).
 *
 * Moves the company files (`TENANT_ASSET_ENTRIES`: company descriptor, vision,
 * organization profile, org chart, OKRs, decision rights, finance, brand,
 * design, channel bindings) — `customer.json` becomes `company.json` — and the
 * audit mirror `logs/audit/` to `active/shared/runtime/audit-mirror/confidential/{tenant}/`.
 * Customer records (`deals/`) stay until S3. Run after 0001-stance-home.
 *
 * Run with `pnpm migration --dry-run` first: it prints every move and writes
 * nothing. Existing targets are never overwritten; such an entry is reported
 * and left in place.
 */
import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/authority';
import { logger } from '@agent/core/core';
import { isValidTenantSlug } from '@agent/core/foundation/scope';
import {
  TENANT_COMPANY_FILE,
  TENANT_HOME_ROOT,
  isTenantAssetEntry,
} from '@agent/core/organization/tenant-registry';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeMoveSync,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { PARTITIONED_RUNTIME_LEDGER_ROOTS } from '@agent/core/storage-layout';

export const id = '0002-tenant-home';
export const description =
  'Move tenant company assets from customer/{tenant}/ to knowledge/confidential/{tenant}/ (deals stay)';
export const introduced_in = 'refactor/core-package-split (S2)';

const LEGACY_DIR = 'customer';
const LEGACY_COMPANY_FILE = 'customer.json';

interface Move {
  from: string;
  to: string;
}

function rel(absolute: string): string {
  return path.relative(pathResolver.rootDir(), absolute).split(path.sep).join('/');
}

function safe(target: string): string {
  return assertSafeRepositoryPath(target, {
    allowMissingLeaf: true,
    rootDir: pathResolver.rootDir(),
  });
}

/** Company asset moves for one legacy directory (the audit mirror is planned separately). */
export function planTenantHomeMoves(slug: string, rootDir = pathResolver.rootDir()): Move[] {
  const legacy = path.join(rootDir, LEGACY_DIR, slug);
  const home = path.join(rootDir, TENANT_HOME_ROOT, slug);
  const moves: Move[] = [];
  for (const entry of safeReaddir(legacy).sort()) {
    const from = path.join(legacy, entry);
    if (entry === LEGACY_COMPANY_FILE) {
      moves.push({ from, to: path.join(home, TENANT_COMPANY_FILE) });
      continue;
    }
    if (entry === 'connections' && safeLstat(from).isDirectory()) {
      // Only the channel bindings are the tenant's; other connections were moved
      // with the stance by 0001.
      for (const child of safeReaddir(from).sort()) {
        if (isTenantAssetEntry(`${entry}/${child}`))
          moves.push({ from: path.join(from, child), to: path.join(home, entry, child) });
      }
      continue;
    }
    if (isTenantAssetEntry(entry)) moves.push({ from, to: path.join(home, entry) });
  }
  return moves;
}

/** The legacy audit mirror directory and its new partition. */
export function planAuditMirrorMove(slug: string, rootDir = pathResolver.rootDir()): Move | null {
  const from = path.join(rootDir, LEGACY_DIR, slug, 'logs', 'audit');
  if (!safeExistsSync(from)) return null;
  const to = path.join(
    rootDir,
    PARTITIONED_RUNTIME_LEDGER_ROOTS.tenant_audit_mirror,
    'confidential',
    slug
  );
  return { from, to };
}

function moveAuditMirror(slug: string, move: Move, dryRun: boolean): void {
  const from = safe(move.from);
  const to = safe(move.to);
  if (safeExistsSync(to)) {
    logger.warn(
      `[${id}] ${rel(to)} already exists — left ${rel(from)} in place | next: run pnpm audit:mirror-reconcile`
    );
    return;
  }
  logger.info(`[${id}] ${dryRun ? 'would move' : 'move'} ${rel(from)} -> ${rel(to)}`);
  if (dryRun) return;
  const files = safeReaddir(from).sort();
  // Only audit_mirror_writer, bound to the tenant, may write a mirror partition.
  withExecutionContext(
    'audit_mirror_writer',
    () => {
      safeMkdir(to, { recursive: true });
      for (const file of files)
        safeWriteFile(path.join(to, file), safeReadFile(path.join(from, file)));
    },
    undefined,
    slug
  );
  safeRmSync(from, { recursive: true, force: true });
}

export async function migrate(opts: { dryRun: boolean }): Promise<void> {
  const root = pathResolver.rootDir();
  const legacyRoot = safe(path.join(root, LEGACY_DIR));
  if (!safeExistsSync(legacyRoot)) {
    logger.info(`[${id}] no ${LEGACY_DIR}/ directory — nothing to migrate`);
    return;
  }
  // `onboarding` is the governed writer of company files (customer/ and the tenant home).
  withExecutionContext('onboarding', () => {
    for (const slug of safeReaddir(legacyRoot).sort()) {
      if (!isValidTenantSlug(slug) || !safeLstat(path.join(legacyRoot, slug)).isDirectory())
        continue;
      for (const move of planTenantHomeMoves(slug, root)) {
        const from = safe(move.from);
        const to = safe(move.to);
        if (safeExistsSync(to)) {
          logger.warn(
            `[${id}] ${rel(to)} already exists — left ${rel(from)} in place | next: merge it by hand`
          );
          continue;
        }
        logger.info(`[${id}] ${opts.dryRun ? 'would move' : 'move'} ${rel(from)} -> ${rel(to)}`);
        if (opts.dryRun) continue;
        safeMkdir(path.dirname(to), { recursive: true });
        safeMoveSync(from, to);
      }
      const mirror = planAuditMirrorMove(slug, root);
      if (mirror) moveAuditMirror(slug, mirror, opts.dryRun);
    }
  });
  logger.info(`[${id}] done. customer/{tenant}/ now holds only customer records (deals) until S3.`);
}
