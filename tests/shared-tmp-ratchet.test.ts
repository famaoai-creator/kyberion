/**
 * AL-02 registration ceremony: the `sharedTmp()` ratchet.
 *
 * `active/shared/tmp/` is a 24h-TTL consumables floor, but tmp-by-default
 * became a habit: scope-owned artifacts (mission outputs, reports, evidence)
 * were landing on the same floor as throwaway intermediates and losing their
 * scope. AL-02 introduced `writeScopedArtifact` (libs/core/artifact-store.ts)
 * as the sanctioned placement API and fixes the existing call sites at zero
 * growth via this ceremony (same style as tests/core-fs-exception-boundary.test.ts):
 *
 * - Every production (non-test) `sharedTmp(` call site in libs/ and scripts/
 *   must be registered in knowledge/product/governance/shared-tmp-allowlist.json
 *   at file granularity with its exact call count, classified as either
 *   `legit-tmp` (consumable — tmp is correct) or `migrate-candidate`
 *   (scope-owned artifact to move to writeScopedArtifact in a later increment).
 * - A new call site — a new file, or an additional call in an allowlisted
 *   file — fails this test. Use writeScopedArtifact instead, or consciously
 *   register (and classify) the new call in the ledger.
 * - Migrating a call site away must also shrink the ledger (stale entries fail).
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

const rootDir = process.cwd();
const LEDGER_REPO_PATH = 'knowledge/product/governance/shared-tmp-allowlist.json';
const SCAN_ROOTS = ['libs', 'scripts'];
const CLASSIFICATIONS = ['legit-tmp', 'migrate-candidate'] as const;

const GUIDANCE =
  `New sharedTmp() usage detected. active/shared/tmp/ is a 24h-TTL consumables floor — ` +
  `scope-owned artifacts do not belong there. Use writeScopedArtifact() from ` +
  `libs/core/artifact-store.ts (scope: tenant/project/mission/task/session + artifact_class) ` +
  `so the artifact lands in its canonical scope directory and is indexed for lifecycle GC. ` +
  `If the data is genuinely a consumable intermediate, consciously register the call site in ` +
  `${LEDGER_REPO_PATH} with classification "legit-tmp" (or "migrate-candidate" with a note).`;

interface LedgerEntry {
  file: string;
  count: number;
  classification: (typeof CLASSIFICATIONS)[number];
  note?: string;
}

/**
 * Count `sharedTmp(` call sites in a file's content. Skips comment-lead lines
 * and the `function sharedTmp(` definition in path-resolver itself; counts
 * multiple calls on one line.
 */
export function countSharedTmpCallSites(content: string): number {
  let count = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (/^(\/\/|\*|\/\*)/.test(trimmed)) continue;
    if (/function\s+sharedTmp\s*\(/.test(line)) continue;
    const matches = line.match(/\bsharedTmp\s*\(/g);
    if (matches) count += matches.length;
  }
  return count;
}

function isProductionSourceFile(relPath: string): boolean {
  if (!/\.(ts|mts|tsx)$/.test(relPath)) return false;
  if (relPath.endsWith('.d.ts')) return false;
  if (/\.test\.(ts|mts|tsx)$/.test(relPath)) return false;
  if (relPath.includes('/dist/')) return false;
  if (relPath.includes('/node_modules/')) return false;
  return true;
}

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function scanActualCallSites(): Map<string, number> {
  const actual = new Map<string, number>();
  for (const scanRoot of SCAN_ROOTS) {
    for (const filePath of getAllFiles(path.join(rootDir, scanRoot))) {
      const relPath = normalize(path.relative(rootDir, filePath));
      if (!isProductionSourceFile(relPath)) continue;
      const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      const count = countSharedTmpCallSites(content);
      if (count > 0) actual.set(relPath, count);
    }
  }
  return actual;
}

function loadLedger(): LedgerEntry[] {
  const raw = safeReadFile(path.join(rootDir, LEDGER_REPO_PATH), { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(raw) as { entries?: LedgerEntry[] };
  if (!Array.isArray(parsed.entries)) {
    throw new Error(`${LEDGER_REPO_PATH} must contain an "entries" array`);
  }
  return parsed.entries;
}

describe('sharedTmp ratchet (AL-02 registration ceremony)', () => {
  it('ledger entries are well-formed and unique', () => {
    const entries = loadLedger();
    const seen = new Set<string>();
    for (const entry of entries) {
      expect(typeof entry.file, `entry.file must be a string: ${JSON.stringify(entry)}`).toBe(
        'string'
      );
      expect(
        Number.isInteger(entry.count) && entry.count > 0,
        `entry.count must be a positive integer for ${entry.file}`
      ).toBe(true);
      expect(
        CLASSIFICATIONS.includes(entry.classification),
        `entry.classification for ${entry.file} must be one of ${CLASSIFICATIONS.join('|')}`
      ).toBe(true);
      expect(seen.has(entry.file), `duplicate ledger entry for ${entry.file}`).toBe(false);
      seen.add(entry.file);
    }
  });

  it('every production sharedTmp( call site matches the allowlist ledger exactly', () => {
    const actual = scanActualCallSites();
    const ledger = new Map(loadLedger().map((entry) => [entry.file, entry.count]));

    const problems: string[] = [];
    for (const [file, count] of [...actual.entries()].sort()) {
      const allowed = ledger.get(file);
      if (allowed === undefined) {
        problems.push(`UNREGISTERED file with ${count} sharedTmp( call(s): ${file}`);
      } else if (count > allowed) {
        problems.push(
          `GREW: ${file} has ${count} sharedTmp( call(s), ledger allows ${allowed} — the ratchet only goes down`
        );
      } else if (count < allowed) {
        problems.push(
          `STALE COUNT: ${file} has ${count} sharedTmp( call(s), ledger says ${allowed} — shrink the ledger entry to match`
        );
      }
    }
    for (const file of [...ledger.keys()].sort()) {
      if (!actual.has(file)) {
        problems.push(
          `STALE ENTRY: ${file} is in the ledger but has no sharedTmp( calls — remove it`
        );
      }
    }

    expect(problems, `${GUIDANCE}\n\n${problems.join('\n')}`).toEqual([]);
  });

  describe('call-site matcher', () => {
    it('catches a simulated new call site (including multiple calls per line)', () => {
      expect(
        countSharedTmpCallSites(`const p = pathResolver.sharedTmp('new-thing/file.json');`)
      ).toBe(1);
      expect(
        countSharedTmpCallSites(
          `const a = sharedTmp('a');\nconst b = join(sharedTmp('b'), sharedTmp('c'));`
        )
      ).toBe(3);
    });

    it('ignores comments and the path-resolver definition itself', () => {
      expect(countSharedTmpCallSites(`// migrated away from sharedTmp('x')`)).toBe(0);
      expect(countSharedTmpCallSites(` * used to call sharedTmp('x')`)).toBe(0);
      expect(countSharedTmpCallSites(`export function sharedTmp(subPath = '') {`)).toBe(0);
      expect(countSharedTmpCallSites(`const tmp = pathResolver.sharedTmpSomethingElse('x');`)).toBe(
        0
      );
    });
  });
});
