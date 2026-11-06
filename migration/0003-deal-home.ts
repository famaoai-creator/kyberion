/**
 * S3 of the store-catalog guard design: move each tenant's customer records
 * (deals with their documents, requirements captures, escalations and the deal
 * log) from the legacy `customer/{tenant}/deals/` into the tenant home,
 * `knowledge/confidential/{tenant}/deals/`. Repo-relative references inside
 * the moved JSON files (`quote_ref`, `contract_ref`, evidence refs) follow the
 * move. A legacy `customer/{tenant}/` left empty is removed, and so is an empty
 * `customer/`. Run after 0001-stance-home and 0002-tenant-home.
 *
 * Run with `pnpm migration --dry-run` first: it prints every move and writes
 * nothing. An existing target is never overwritten; that tenant is reported
 * and left in place.
 */
import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/authority';
import { logger } from '@agent/core/core';
import { asDealStore } from '@agent/core/deal-store';
import { isValidTenantSlug } from '@agent/core/foundation/scope';
import { TENANT_DEALS_DIR, TENANT_HOME_ROOT } from '@agent/core/organization/tenant-registry';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';

export const id = '0003-deal-home';
export const description =
  'Move tenant customer records from customer/{tenant}/deals/ to knowledge/confidential/{tenant}/deals/';
export const introduced_in = 'refactor/core-package-split (S3)';

const LEGACY_DIR = 'customer';

function rel(absolute: string): string {
  return path.relative(pathResolver.rootDir(), absolute).split(path.sep).join('/');
}

function safe(target: string): string {
  return assertSafeRepositoryPath(target, {
    allowMissingLeaf: true,
    rootDir: pathResolver.rootDir(),
  });
}

/** Rewrite repo-relative references from the legacy deal folder to the new one. */
export function relinkDealRefs(text: string, slug: string): string {
  return text
    .split(`${LEGACY_DIR}/${slug}/${TENANT_DEALS_DIR}/`)
    .join(`${TENANT_HOME_ROOT}/${slug}/${TENANT_DEALS_DIR}/`);
}

/** Every file under `dir`, relative to it (POSIX separators), depth first and sorted. */
export function listFiles(dir: string, prefix = ''): string[] {
  const stat = safeLstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`[${id}] unsupported source directory: ${dir}`);
  const files: string[] = [];
  for (const entry of safeReaddir(dir).sort()) {
    const full = path.join(dir, entry);
    const relative = prefix ? `${prefix}/${entry}` : entry;
    const entryStat = safeLstat(full);
    if (entryStat.isSymbolicLink()) throw new Error(`[${id}] unsupported symbolic link: ${full}`);
    if (entryStat.isDirectory()) files.push(...listFiles(full, relative));
    else if (entryStat.isFile()) files.push(relative);
    else throw new Error(`[${id}] unsupported source entry: ${full}`);
  }
  return files;
}

interface DealMove {
  slug: string;
  legacyTenant: string;
  from: string;
  to: string;
  files: string[];
}

function planDeals(slug: string): DealMove | undefined {
  const root = pathResolver.rootDir();
  const legacyTenant = safe(path.join(root, LEGACY_DIR, slug));
  const from = safe(path.join(legacyTenant, TENANT_DEALS_DIR));
  if (!safeExistsSync(from)) return;
  const to = safe(path.join(root, TENANT_HOME_ROOT, slug, TENANT_DEALS_DIR));
  if (asDealStore(slug, () => safeExistsSync(to))) {
    logger.warn(
      `[${id}] ${rel(to)} already exists — left ${rel(from)} in place | next: merge it by hand`
    );
    return;
  }
  return { slug, legacyTenant, from, to, files: listFiles(from) };
}

function moveDeals({ slug, legacyTenant, from, to, files }: DealMove): void {
  // Only the tenant-bound deal store may write the tenant's deal folder.
  asDealStore(slug, () => {
    for (const file of files) {
      const source = safe(path.join(from, ...file.split('/')));
      const target = safe(path.join(to, ...file.split('/')));
      const relink = file.endsWith('.json') || file.endsWith('.jsonl');
      // Only reference-bearing JSON is text. Attachments and every other file
      // retain their exact bytes, including invalid UTF-8 and byte-order marks.
      const content = relink
        ? relinkDealRefs(safeReadFile(source, { encoding: 'utf8' }) as string, slug)
        : safeReadFile(source, { encoding: null });
      safeMkdir(path.dirname(target), { recursive: true });
      safeWriteFile(target, content, { createOnly: true });
    }
  });
  safeRmSync(from, { recursive: true, force: true });
  if (safeReaddir(legacyTenant).length === 0)
    safeRmSync(legacyTenant, { recursive: true, force: true });
}

export async function migrate(opts: { dryRun: boolean }): Promise<void> {
  const root = pathResolver.rootDir();
  const legacyRoot = safe(path.join(root, LEGACY_DIR));
  if (!safeExistsSync(legacyRoot)) {
    logger.info(`[${id}] no ${LEGACY_DIR}/ directory — nothing to migrate`);
    return;
  }
  // `onboarding` is the governed writer of the legacy customer/ tree it empties.
  withExecutionContext('onboarding', () => {
    const plans: DealMove[] = [];
    const entries = safeReaddir(legacyRoot).sort();
    if (entries.includes('README.md')) {
      const readme = safeLstat(path.join(legacyRoot, 'README.md'));
      if (readme.isSymbolicLink() || !readme.isFile())
        throw new Error(`[${id}] unsupported legacy README.md entry`);
    }
    for (const slug of entries) {
      if (!isValidTenantSlug(slug) || !safeLstat(path.join(legacyRoot, slug)).isDirectory())
        continue;
      const plan = planDeals(slug);
      if (plan) plans.push(plan);
    }
    // Validate every tenant before the first copy or deletion, even in dry-run.
    for (const plan of plans) {
      logger.info(
        `[${id}] ${opts.dryRun ? 'would move' : 'move'} ${rel(plan.from)} -> ${rel(plan.to)} (${plan.files.length} files)`
      );
      if (!opts.dryRun) moveDeals(plan);
    }
    const left = safeReaddir(legacyRoot).filter((entry) => {
      if (entry !== 'README.md') return true;
      const readme = safeLstat(path.join(legacyRoot, entry));
      return readme.isSymbolicLink() || !readme.isFile();
    });
    if (!opts.dryRun && left.length === 0) {
      safeRmSync(legacyRoot, { recursive: true, force: true });
      logger.info(`[${id}] removed the empty legacy ${LEGACY_DIR}/ directory`);
    } else if (left.length > 0) {
      logger.info(`[${id}] ${LEGACY_DIR}/ still holds: ${left.join(', ')} — inspect it by hand`);
    }
  });
}
