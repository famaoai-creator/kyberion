import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeLstat, safeReadFile, safeReaddir } from './secure-io.js';

/**
 * Registration ceremony (KD-04). Any production file that builds a
 * `<untrusted_*>`/`<untrusted-*>`-style tag via raw string concatenation
 * bypasses the shared injection framing contract (`frameUntrustedInput` in
 * untrusted-input-framing.ts) — new untrusted-data injection sites should
 * call that helper instead of hand-rolling escape + tag + boilerplate.
 * A hit here must be reviewed and either migrated to `frameUntrustedInput`
 * or added to the allowlist below with a reason.
 */
const ALLOWLIST = [
  // The contract itself: constructs the tag on purpose.
  /\/libs\/core\/untrusted-input-framing\.ts$/,
  // SA-03: independent scan + wrap + audit + alert contract (predates KD-04,
  // has its own established tests in untrusted-content.test.ts). Not a plain
  // framing helper — reviewed exception, not a bypass to migrate silently.
  /\/libs\/core\/untrusted-content\.ts$/,
];

const RAW_UNTRUSTED_TAG_PATTERN = /<untrusted[_-]/i;

/**
 * Strip `//` and `/* *\/` comments so mentioning the tag in a doc comment
 * (e.g. "calls frameUntrustedInput instead of `<untrusted_data>`") does not
 * false-positive as a real construction site. Good enough for this
 * repo's comment style — not a full TS parser.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function collectProductionTsFiles(dir: string): string[] {
  const entries = safeReaddir(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = `${dir}/${entry}`;
    const stat = safeLstat(fullPath);
    if (stat.isDirectory()) {
      if (entry === 'dist' || entry === 'node_modules') continue;
      files.push(...collectProductionTsFiles(fullPath));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.d.ts')) continue;
    if (entry.endsWith('.test.ts')) continue;
    files.push(fullPath);
  }
  return files;
}

describe('untrusted input framing boundary (KD-04)', () => {
  it('keeps raw <untrusted_*> tag construction confined to reviewed, allowlisted sites', () => {
    const repoRoot = pathResolver.rootDir();
    const candidates = [
      ...collectProductionTsFiles(`${repoRoot}/libs`),
      ...collectProductionTsFiles(`${repoRoot}/scripts`),
    ];

    const offenders = candidates.filter((filePath) => {
      const source = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      if (!RAW_UNTRUSTED_TAG_PATTERN.test(stripComments(source))) return false;
      return !ALLOWLIST.some((pattern) => pattern.test(filePath));
    });

    expect(offenders).toEqual([]);
  });

  it('the allowlist itself only covers files that actually construct the tag (no stale entries)', () => {
    const repoRoot = pathResolver.rootDir();
    const candidates = [
      ...collectProductionTsFiles(`${repoRoot}/libs`),
      ...collectProductionTsFiles(`${repoRoot}/scripts`),
    ];

    for (const pattern of ALLOWLIST) {
      const matches = candidates.filter((filePath) => pattern.test(filePath));
      expect(matches.length).toBeGreaterThan(0);
      for (const filePath of matches) {
        const source = safeReadFile(filePath, { encoding: 'utf8' }) as string;
        expect(RAW_UNTRUSTED_TAG_PATTERN.test(stripComments(source))).toBe(true);
      }
    }
  });
});
