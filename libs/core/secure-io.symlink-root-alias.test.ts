import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/*
 * The checkout can be reached through a symlinked prefix (macOS
 * `/var -> /private/var`, a fixture root under a linked temp dir). The
 * canonical path the guards check must then be expressed in the same logical
 * root space the policy prefixes use, or every write would be judged as
 * "outside the project root". This suite points rootDir() at an alias of a
 * real directory and checks which paths reach the tier guard.
 */

const base = path.join(process.cwd(), 'active', 'shared', 'tmp', 'tests');
const realRoot = path.join(base, `secure-io-root-real-${process.pid}-${Date.now()}`);
const aliasRoot = `${realRoot}-alias`;

const guard = vi.hoisted(() => ({
  seen: [] as string[],
  root: '',
}));

/** Guard calls about this fixture (lazy catalog reads by other modules use the real root). */
function fixturePaths(): string[] {
  return guard.seen.filter((p) => p.includes('secure-io-root-real-'));
}

function insideAlias(p: string): boolean {
  const rel = path.relative(guard.root, path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

vi.mock('./tier-guard.js', () => ({
  validateWritePermission: (p: string) => {
    guard.seen.push(p);
    return insideAlias(p)
      ? { allowed: true }
      : { allowed: false, reason: `[POLICY_VIOLATION] Path outside project root: '${p}'` };
  },
  validateReadPermission: (p: string) => {
    guard.seen.push(p);
    return insideAlias(p)
      ? { allowed: true }
      : { allowed: false, reason: `[POLICY_VIOLATION] Path outside project root: '${p}'` };
  },
  detectTier: () => 'public',
}));

vi.mock('./path-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./path-resolver.js')>();
  return {
    ...actual,
    rootDir: () => guard.root || actual.rootDir(),
    resolve: (p: string) =>
      guard.root && !path.isAbsolute(p) ? path.resolve(guard.root, p) : actual.resolve(p),
  };
});

vi.mock('./governance/policy-engine.js', () => ({
  policyEngine: { evaluate: () => ({ allowed: true, action: 'allow' }) },
}));

describe('secure-io canonicalization under a symlinked checkout prefix', () => {
  let io: typeof import('./secure-io.js');

  beforeAll(async () => {
    // Import first: module bootstrap reads catalogs under the real root.
    io = await import('./secure-io.js');
    fs.mkdirSync(path.join(realRoot, 'data'), { recursive: true });
    fs.mkdirSync(path.join(realRoot, 'other'), { recursive: true });
    fs.symlinkSync(realRoot, aliasRoot, 'dir');
    guard.root = aliasRoot;
  });

  afterAll(() => {
    guard.root = '';
    fs.rmSync(aliasRoot, { force: true });
    fs.rmSync(realRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    guard.seen.length = 0;
  });

  it('judges new and existing paths in the logical (alias) root space', () => {
    io.safeWriteFile('data/new/file.txt', 'x');
    io.safeAppendFileSync('data/new/file.txt', 'y');
    expect(io.safeReadFile('data/new/file.txt')).toBe('xy');
    expect(fs.readFileSync(path.join(realRoot, 'data/new/file.txt'), 'utf8')).toBe('xy');
    expect(fixturePaths().length).toBeGreaterThan(0);
    expect(fixturePaths().filter((p) => !insideAlias(p))).toEqual([]);
  });

  it('maps a link target inside the checkout back to the alias root', () => {
    io.safeSymlinkSync('other', 'data/to-other', 'dir');
    io.safeWriteFile('data/to-other/through.txt', 'z');
    expect(fs.readFileSync(path.join(realRoot, 'other/through.txt'), 'utf8')).toBe('z');
    expect(guard.seen).toContain(path.join(aliasRoot, 'other', 'through.txt'));
    expect(fixturePaths().filter((p) => !insideAlias(p))).toEqual([]);
  });

  it('lists and stats a symlinked checkout root without /proc/self/fd', async () => {
    const pathGuard = await import('./secure-io-path-guard.js');
    const previous = pathGuard.setProcFdLookupDisabledForTesting(true);
    try {
      expect(io.safeReaddir(aliasRoot).sort()).toEqual(expect.arrayContaining(['data', 'other']));
      expect(io.safeStat(aliasRoot).isDirectory()).toBe(true);
    } finally {
      pathGuard.setProcFdLookupDisabledForTesting(previous);
    }
  });
});
