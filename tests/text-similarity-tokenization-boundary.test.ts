import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

/**
 * Text-similarity tokenization boundary.
 *
 * A module that scores text similarity / overlap (Jaccard, cosine over hashed
 * tokens, keyword overlap, …) must tokenize natural language with the shared
 * ICU segmenter in `@agent/core/foundation/locale-normalize` — `segmentWords` for set
 * similarity, `segmentKeywordTerms` for substring / keyword matching.
 * Whitespace-only tokenization (`split(/\s+/)`, `split(' ')`) turns a Japanese
 * or Chinese sentence into ONE token, so every overlap score on those locales
 * silently collapses to 0 or 1 (found reviewing PR #1411).
 *
 * The scan flags whitespace-only `split` calls in any source file (libs,
 * scripts, presence, satellites; tests excluded) that defines a function or
 * const whose name contains jaccard / similarity / overlap. A justified use
 * (the split parses identifiers or CLI args, or a separate locale-aware path
 * handles spaceless scripts) is registered below with its exact count and a
 * reason. Rule: knowledge/product/governance/kyberion-development-practices.md
 * ("Cross-language determinism").
 */
const ALLOWED_WHITESPACE_SPLITS: Record<string, { count: number; reason: string }> = {
  'libs/core/voice/voice-respond-gate.ts': {
    count: 1,
    reason:
      'isPureDisfluency matches English filler words on spaces; Japanese fillers go through ' +
      'the separate jaPureFillerRe path on the whitespace-stripped text.',
  },
};

const SOURCE_ROOTS = ['libs', 'scripts', 'presence', 'satellites'];
const SIMILARITY_DEFINITION =
  /(?:function\s+|(?:const|let)\s+)\w*(?:jaccard|similarity|overlap)\w*\s*(?:=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]*)?=>|\(|<)/i;
const WHITESPACE_SPLIT =
  /\.split\(\s*(?:\/\\s\+\/[a-z]*|\/ \+\/[a-z]*|\/\[\\s,?\]\+\/[a-z]*|' '|" ")\s*\)/g;

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

function countWhitespaceSplitsInSimilarityModule(source: string): number | null {
  const code = stripComments(source);
  if (!SIMILARITY_DEFINITION.test(code)) return null;
  return (code.match(WHITESPACE_SPLIT) ?? []).length;
}

describe('Text-similarity tokenization boundary', () => {
  it('detects whitespace-only tokenization only inside similarity modules', () => {
    expect(
      countWhitespaceSplitsInSimilarityModule(
        "function jaccard(a, b) {}\nconst t = text.toLowerCase().split(/\\s+/u);\nx.split(' ');"
      )
    ).toBe(2);
    expect(
      countWhitespaceSplitsInSimilarityModule(
        'const goalSimilarity = (a: string) => a;\nsegmentWords(a);'
      )
    ).toBe(0);
    // A CLI parser with no similarity function is out of scope.
    expect(countWhitespaceSplitsInSimilarityModule('const argv = line.split(/\\s+/);')).toBeNull();
    // Commented-out code does not count.
    expect(
      countWhitespaceSplitsInSimilarityModule('function overlapScore() {}\n// a.split(/\\s+/)')
    ).toBe(0);
  });

  it('keeps whitespace-only tokenization out of text-similarity modules', () => {
    const actual: Record<string, number> = {};
    for (const directory of SOURCE_ROOTS) {
      for (const filePath of getAllFiles(path.join(rootDir, directory))) {
        const relPath = normalize(path.relative(rootDir, filePath));
        if (!/\.(ts|tsx|mts|cts|js|mjs)$/.test(relPath)) continue;
        if (/(^|\/)(node_modules|dist|\.next)\//.test(relPath)) continue;
        if (/\.test\.[cm]?[jt]sx?$/.test(relPath)) continue;
        const source = safeReadFile(filePath, { encoding: 'utf8' }) as string;
        const count = countWhitespaceSplitsInSimilarityModule(source);
        if (count) actual[relPath] = count;
      }
    }
    const expected = Object.fromEntries(
      Object.entries(ALLOWED_WHITESPACE_SPLITS).map(([file, entry]) => [file, entry.count])
    );
    expect(
      actual,
      'whitespace-only tokenization in a text-similarity module — split(/\\s+/) / split(" ") ' +
        'makes a Japanese/Chinese sentence one token, so overlap scores collapse | next: tokenize ' +
        "with segmentWords (set similarity) or segmentKeywordTerms (keyword/substring matching) from '@agent/core/foundation/locale-normalize'; " +
        'if the split parses identifiers/CLI args or a separate locale-aware path covers spaceless ' +
        'scripts, register the file with its exact count and a reason in ALLOWED_WHITESPACE_SPLITS ' +
        '(and drop an entry whose splits are gone)'
    ).toEqual(expected);
  }, 60000);
});
