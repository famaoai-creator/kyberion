import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile, safeReaddir, safeStat } from '@agent/core';
import vocabulary from '../knowledge/product/orchestration/user-facing-vocabulary.json';
import { createBrowserVocabularyResolver } from '@agent/core/locale-normalize';

// UX-03 Task 5.3: uxText/uxLabel no longer take per-call fallbacks — the
// vocabulary catalog is the single source of truth. This contract walks the
// chronos source and fails when a referenced key is missing from the catalog
// (the old failure mode was silent drift between dead fallback strings and
// what actually rendered).

const CHRONOS_SRC = path.join(process.cwd(), 'presence/displays/chronos-mirror-v2/src');

// Use the same resolver as the browser: qualified names must stay in their
// named namespace, and ambiguous bare names are refused rather than flattened.
const browserVocabulary = createBrowserVocabularyResolver(vocabulary);

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
    const missing: string[] = [];
    let referenced = 0;

    for (const file of walkFiles(CHRONOS_SRC)) {
      const source = safeReadFile(file, { encoding: 'utf8' }) as string;
      for (const match of source.matchAll(/ux(?:Text|Label)\(\s*'([^']+)'/g)) {
        referenced += 1;
        if (!browserVocabulary.resolveEntry(match[1])) {
          missing.push(`${path.relative(process.cwd(), file)}: ${match[1]}`);
        }
      }
    }

    expect(referenced).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  it('every literal uxTextOr/mt key referenced in chronos exists in the catalog', () => {
    // uxTextOr carries a fallback for keys computed at runtime, which the check
    // above cannot see. Used with a LITERAL key it is a silent ja regression
    // instead: the English fallback renders in every locale and nothing fails.
    // MissionIntelligence's `mt` helper is uxTextOr under another name, so it
    // is held to the same rule.
    const missing: string[] = [];
    let referenced = 0;

    for (const file of walkFiles(CHRONOS_SRC)) {
      const source = safeReadFile(file, { encoding: 'utf8' }) as string;
      for (const match of source.matchAll(/\b(?:uxTextOr|mt)\(\s*'([^']+)'/g)) {
        referenced += 1;
        if (!browserVocabulary.resolveEntry(match[1])) {
          missing.push(`${path.relative(process.cwd(), file)}: ${match[1]}`);
        }
      }
    }

    expect(referenced).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  it('accepts a qualified mission key without accepting the same suffix in another namespace', () => {
    expect(browserVocabulary.resolveEntry('mission:mission_distillation_label')?.namespace).toBe(
      'mission'
    );
    expect(browserVocabulary.resolveEntry('unknown:mission_distillation_label')).toBeNull();
    expect(browserVocabulary.resolveEntry('chronos:mission_distillation_label')).toBeNull();
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
