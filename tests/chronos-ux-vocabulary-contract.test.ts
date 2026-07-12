import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile, safeReaddir, safeStat } from '@agent/core';
import vocabulary from '../knowledge/product/orchestration/user-facing-vocabulary.json';

// UX-03 Task 5.3: uxText/uxLabel no longer take per-call fallbacks — the
// vocabulary catalog is the single source of truth. This contract walks the
// chronos source and fails when a referenced key is missing from the catalog
// (the old failure mode was silent drift between dead fallback strings and
// what actually rendered).

const CHRONOS_SRC = path.join(process.cwd(), 'presence/displays/chronos-mirror-v2/src');

function* walkFiles(dir: string): Generator<string> {
  for (const entry of safeReaddir(dir) as string[]) {
    const full = path.join(dir, entry);
    if (safeStat(full).isDirectory()) {
      yield* walkFiles(full);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.includes('.test.')) {
      yield full;
    }
  }
}

describe('chronos ux vocabulary contract (UX-03)', () => {
  it('every uxText/uxLabel key referenced in chronos exists in the catalog', () => {
    const ux = (vocabulary as any).domains?.ux ?? {};
    const missing: string[] = [];
    let referenced = 0;

    for (const file of walkFiles(CHRONOS_SRC)) {
      const source = safeReadFile(file, { encoding: 'utf8' }) as string;
      for (const match of source.matchAll(/ux(?:Text|Label)\(\s*'([^']+)'/g)) {
        referenced += 1;
        if (!ux[match[1]]) {
          missing.push(`${path.relative(process.cwd(), file)}: ${match[1]}`);
        }
      }
    }

    expect(referenced).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  it('uxText no longer accepts inline fallback strings', () => {
    const offenders: string[] = [];
    for (const file of walkFiles(CHRONOS_SRC)) {
      const source = safeReadFile(file, { encoding: 'utf8' }) as string;
      for (const match of source.matchAll(/uxText\(\s*'[^']+'\s*,\s*'/g)) {
        offenders.push(`${path.relative(process.cwd(), file)}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
