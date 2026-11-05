/**
 * S1 of the store-catalog guard design: move each stance out of the legacy
 * `customer/{slug}/` directory into `knowledge/personal/stances/{slug}/`.
 *
 * Only stance entries move (identity, connections, policy, voice, mission
 * seeds, tenant profiles, onboarding — `STANCE_ENTRIES`).
 * The tenant files that shared the directory (company descriptor, organization
 * profile, vision, org chart, OKRs, decision rights, brand, design, deals, audit mirror, channel
 * bindings) stay for 0002-tenant-home (S2) and S3. Stance traces move to
 * `active/shared/logs/stances/{slug}/traces/`. A `stance.json` is written from
 * the legacy `customer.json` when the stance has none.
 *
 * Run with `pnpm migration --dry-run` first: it prints every move and writes
 * nothing. Existing targets are never overwritten; such an entry is reported
 * and left in place.
 */
import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/authority';
import { readJsonIfPresent, writeJson } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeMoveSync,
  safeReaddir,
} from '@agent/core/secure-io';
import { logger } from '@agent/core/core';
import { STANCE_LOGS_DIR, STANCES_DIR, isStanceEntry } from '@agent/core/stance-resolver';

export const id = '0001-stance-home';
export const description =
  'Move stances from customer/{slug}/ to knowledge/personal/stances/{slug}/ (tenant files stay)';
export const introduced_in = 'refactor/core-package-split (S1)';

const LEGACY_DIR = 'customer';
const SKIP = new Set(['README.md', '_template']);

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

/** Moves for one legacy directory: stance entries one level deep, plus nested stance-only children. */
export function planStanceMoves(slug: string, rootDir = pathResolver.rootDir()): Move[] {
  const legacy = path.join(rootDir, LEGACY_DIR, slug);
  const stance = path.join(rootDir, STANCES_DIR, slug);
  const moves: Move[] = [];
  for (const entry of safeReaddir(legacy).sort()) {
    const from = path.join(legacy, entry);
    if (entry === 'logs') {
      const traces = path.join(from, 'traces');
      if (safeExistsSync(traces))
        moves.push({ from: traces, to: path.join(rootDir, STANCE_LOGS_DIR, slug, 'traces') });
      continue;
    }
    if (!isStanceEntry(entry)) continue;
    if (entry === 'connections' && safeLstat(from).isDirectory()) {
      // channel-bindings.json belongs to the tenant; every other connection belongs to the stance.
      for (const child of safeReaddir(from).sort()) {
        const childRel = `${entry}/${child}`;
        if (isStanceEntry(childRel))
          moves.push({ from: path.join(from, child), to: path.join(stance, entry, child) });
      }
      continue;
    }
    moves.push({ from, to: path.join(stance, entry) });
  }
  return moves;
}

function writeStanceDescriptor(slug: string, dryRun: boolean): void {
  const root = pathResolver.rootDir();
  const target = safe(path.join(root, STANCES_DIR, slug, 'stance.json'));
  if (safeExistsSync(target)) return;
  const legacy = readJsonIfPresent<{
    display_name?: string;
    engagement_type?: string;
    notes?: string;
  }>(safe(path.join(root, LEGACY_DIR, slug, 'customer.json')));
  const descriptor = {
    slug,
    display_name: legacy?.display_name || slug,
    kind: 'engagement',
    notes: legacy?.notes || `Migrated from ${LEGACY_DIR}/${slug}/customer.json by ${id}.`,
  };
  logger.info(`[${id}] ${dryRun ? 'would write' : 'write'} ${rel(target)}`);
  if (!dryRun) writeJson(target, descriptor);
}

export async function migrate(opts: { dryRun: boolean }): Promise<void> {
  const root = pathResolver.rootDir();
  const legacyRoot = safe(path.join(root, LEGACY_DIR));
  if (!safeExistsSync(legacyRoot)) {
    logger.info(`[${id}] no ${LEGACY_DIR}/ directory — nothing to migrate`);
    return;
  }
  withExecutionContext('mission_controller', () => {
    for (const slug of safeReaddir(legacyRoot).sort()) {
      if (SKIP.has(slug) || !safeLstat(path.join(legacyRoot, slug)).isDirectory()) continue;
      const moves = planStanceMoves(slug, root);
      for (const move of moves) {
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
      if (moves.length > 0) writeStanceDescriptor(slug, opts.dryRun);
    }
  });
  logger.info(
    `[${id}] done. Set KYBERION_STANCE instead of KYBERION_CUSTOMER (pnpm stance:switch <slug> writes active/shared/runtime/stance.env).`
  );
}
