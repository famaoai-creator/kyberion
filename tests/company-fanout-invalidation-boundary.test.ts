import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

/**
 * Company fan-out invalidation boundary.
 *
 * The personal (all-company) view reads one home per company through a short
 * per-viewer cache (`presence/displays/concierge/src/lib/company-fanout-cache.ts`).
 * A cached read must never bring back an item the viewer just decided, so
 * every Concierge API route whose mutating handler changes a needs-you store
 * — the approval store, the memory-promotion queue, the deliverable inbox,
 * the hygiene inquiries — must export that handler through
 * `withCompanyFanoutInvalidation(...)`.
 *
 * A route is in scope when it exports POST / PUT / PATCH / DELETE and its own
 * source, or any concierge source it reaches through relative imports, calls
 * one of the needs-you mutation entry points below. An exception needs a
 * reason in ALLOWLIST.
 */

const rootDir = process.cwd();
const CONCIERGE_SRC = 'presence/displays/concierge/src';
const API_DIR = `${CONCIERGE_SRC}/app/api`;

/** Calls that change what the needs-you queue shows. */
const NEEDS_YOU_MUTATIONS = [
  'decideApprovalRequest',
  'decideApprovalRequestUnderLock',
  'updateMemoryPromotionCandidateStatus',
  'reviewMemoryPromotionCandidate',
  'markInboxEntry',
  'acceptInboxEntryWithHumanReceipt',
  'reviewDeliverable',
  'findHygieneInquiry',
];
const MUTATION_RE = new RegExp(`\\b(${NEEDS_YOU_MUTATIONS.join('|')})\\s*\\(`);
const MUTATING_EXPORT_RE =
  /export\s+(?:async\s+)?(?:function\s+|const\s+)(POST|PUT|PATCH|DELETE)\b/g;

/** route (repo-relative) → why it may mutate a needs-you store without invalidating. */
const ALLOWLIST: Record<string, string> = {};

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = normalize(path.join(path.dirname(fromFile), specifier)).replace(/\.js$/, '');
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    base,
  ]) {
    if (/\.(ts|tsx)$/.test(candidate) && safeExistsSync(path.join(rootDir, candidate)))
      return candidate;
  }
  return null;
}

/** The route plus every concierge source reachable through relative imports. */
function reachableSources(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const src = stripComments(read(file));
    seen.set(file, src);
    for (const match of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const resolved = resolveRelative(file, match[1]!);
      if (resolved && resolved.startsWith(`${CONCIERGE_SRC}/`) && !/\.test\./.test(resolved))
        queue.push(resolved);
    }
  }
  return seen;
}

function routeFiles(): string[] {
  return getAllFiles(path.join(rootDir, API_DIR))
    .map((file) => normalize(path.relative(rootDir, file)))
    .filter((file) => /\/route\.ts$/.test(file));
}

describe('company fan-out invalidation boundary', () => {
  it('every needs-you mutation route clears the personal fan-out cache', () => {
    const violations: string[] = [];
    const inScope: string[] = [];
    for (const route of routeFiles()) {
      const own = stripComments(read(route));
      const methods = [...own.matchAll(MUTATING_EXPORT_RE)].map((match) => match[1]!);
      if (methods.length === 0) continue;
      const mutates = [...reachableSources(route).values()].some((src) => MUTATION_RE.test(src));
      if (!mutates) continue;
      inScope.push(route);
      if (ALLOWLIST[route]) continue;
      for (const method of methods) {
        const wrapped = new RegExp(
          `export\\s+const\\s+${method}\\s*=\\s*withCompanyFanoutInvalidation\\(`
        ).test(own);
        if (!wrapped) violations.push(`${route} ${method}`);
      }
    }
    // The scan must keep finding the known decision routes.
    expect(inScope).toEqual(
      expect.arrayContaining([
        `${API_DIR}/approvals/[id]/route.ts`,
        `${API_DIR}/memory-queue/[id]/route.ts`,
        `${API_DIR}/outcomes/[id]/route.ts`,
        `${API_DIR}/hygiene/[id]/route.ts`,
      ])
    );
    expect(
      violations,
      violations.length
        ? `needs-you mutation route does not invalidate the company fan-out cache — a cached personal-view read would show the just-decided item again | next: export the handler as \`export const ${'<METHOD>'} = withCompanyFanoutInvalidation(handler)\` (lib/company-fanout-cache) or add it to ALLOWLIST with a reason | evidence: ${violations.join(', ')}`
        : undefined
    ).toEqual([]);
  });

  it('keeps the allowlist free of stale entries', () => {
    const stale = Object.keys(ALLOWLIST).filter(
      (route) => !safeExistsSync(path.join(rootDir, route))
    );
    expect(
      stale,
      `stale company fan-out allowlist entry — the route no longer exists | next: remove it from ALLOWLIST | evidence: ${stale.join(', ')}`
    ).toEqual([]);
  });
});
