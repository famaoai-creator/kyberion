import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

/**
 * Tier / Member Role type single-source boundary (concept model v2 D5, S1).
 *
 * The data tier has exactly one declaration: the `KNOWLEDGE_TIERS` tuple
 * (`KnowledgeTier`) in libs/core/foundation/knowledge-tier.ts, re-exported as
 * `StorageDataTier` from libs/core/storage-layout.ts for libs/core modules. No
 * module spells the literal union `'personal' | 'confidential' | 'public'`. The Member Role
 * union `'owner' | 'approver' | 'operator' | 'viewer'` has exactly one
 * declaration: `MemberRole` in libs/core/organization/member-registry.ts.
 * Every other libs/core module imports the canonical type (`import type`, so
 * the foundation weight is unchanged) and expresses aliases as
 * `export type X = StorageDataTier`, subsets as `Exclude<>` / `Extract<>`, and
 * supersets as `StorageDataTier | 'extra'`.
 *
 * The scan flags any literal union run (in any order) that contains every
 * member of either union, outside its canonical file. Tests are excluded.
 * Decision: knowledge/product/architecture/decisions/2026-11-10-concept-model-v2.md (D5).
 */
const UNIONS = [
  {
    name: 'data tier',
    canonical: 'libs/core/foundation/knowledge-tier.ts',
    members: ['personal', 'confidential', 'public'],
  },
  {
    name: 'Member Role',
    canonical: 'libs/core/organization/member-registry.ts',
    members: ['owner', 'approver', 'operator', 'viewer'],
  },
] as const;

const rootDir = process.cwd();

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:\\])\/\/.*$/, '$1'))
    .join('\n');
}

/** Literal union runs (`'a' | 'b' | …`) made only of the given members, with each run's member set. */
function fullUnionRuns(source: string, members: readonly string[]): string[] {
  const literal = `'(?:${members.join('|')})'`;
  const run = new RegExp(`${literal}(?:\\s*\\|\\s*${literal})+`, 'g');
  return (stripComments(source).match(run) ?? []).filter((match) => {
    const found = new Set([...match.matchAll(/'(\w+)'/g)].map((m) => m[1]));
    return members.every((member) => found.has(member));
  });
}

describe('Tier / Member Role type single-source boundary', () => {
  it('detects a redeclared union in any member order', () => {
    expect(
      fullUnionRuns("type T = 'public' | 'confidential' | 'personal';", UNIONS[0].members)
    ).toHaveLength(1);
    expect(fullUnionRuns("tier?: 'personal' | 'confidential';", UNIONS[0].members)).toHaveLength(0);
    expect(
      fullUnionRuns("role: 'viewer' | 'owner' | 'approver' | 'operator';", UNIONS[1].members)
    ).toHaveLength(1);
    expect(
      fullUnionRuns("role?: 'owner' | 'approver' | 'viewer';", UNIONS[1].members)
    ).toHaveLength(0);
  });

  it('declares each union only in its canonical libs/core module', () => {
    const files = getAllFiles(path.join(rootDir, 'libs/core'))
      .map((filePath) => normalize(path.relative(rootDir, filePath)))
      .filter((relPath) => /\.(ts|tsx)$/.test(relPath))
      .filter((relPath) => !/\.test\.tsx?$/.test(relPath) && !relPath.endsWith('.d.ts'))
      .filter((relPath) => !relPath.includes('/dist/') && !relPath.includes('/node_modules/'));

    const violations: string[] = [];
    for (const relPath of files) {
      const source = safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
      for (const union of UNIONS) {
        if (relPath === union.canonical) continue;
        for (const match of fullUnionRuns(source, union.members)) {
          violations.push(`${relPath}: ${union.name} union ${match}`);
        }
      }
    }
    expect(violations).toEqual([]);
  }, 30000);
});
