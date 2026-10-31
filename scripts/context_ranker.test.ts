import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core';
import { ScriptExitError } from './lib/harness.js';
import { normalizeRankingWeights, parseRankArgs, type RankingWeights } from './context_ranker.js';

const defaults: RankingWeights = {
  title: 10,
  id: 5,
  tag: 15,
  category: 3,
  role: 25,
  phase: 18,
  scope: 12,
  kind: 10,
  authority: 8,
  proximity: 1,
  usage_yield: 4,
};

describe('context ranker configuration boundary', () => {
  it('projects only finite numeric ranking weights from the governed shape', () => {
    expect(
      normalizeRankingWeights(
        {
          algorithms: {
            ranking: {
              weights: { title: 20, role: 'invalid', tag: Number.POSITIVE_INFINITY },
            },
          },
        },
        defaults
      )
    ).toEqual({ title: 20 });
  });

  it('ignores primitive, array, and incomplete configuration shapes', () => {
    expect(normalizeRankingWeights([], defaults)).toEqual({});
    expect(normalizeRankingWeights('invalid', defaults)).toEqual({});
    expect(normalizeRankingWeights({ algorithms: { ranking: { weights: [] } } }, defaults)).toEqual(
      {}
    );
  });

  it('treats a positional query as an alias for --intent', () => {
    const positional = parseRankArgs(['mission usability investigation']);
    const flagged = parseRankArgs(['--intent', 'mission usability investigation']);
    expect(positional.intent).toBe('mission usability investigation');
    expect(positional.intent).toBe(flagged.intent);
    expect(positional.limit).toBe(7);
    expect(positional.scope).toBe('repository');
  });

  it('accepts positional and --intent only when they agree', () => {
    expect(parseRankArgs(['--intent', 'same query', 'same query']).intent).toBe('same query');
    expect(() => parseRankArgs(['--intent', 'alpha', 'beta'])).toThrow(/conflicting queries/);
    expect(() => parseRankArgs(['--intent', 'alpha', 'beta'])).toThrow(ScriptExitError);
  });

  it('rejects an empty query, unknown flags, and missing flag values', () => {
    for (const argv of [
      [],
      ['--intent', '   '],
      ['--bogus', 'x'],
      ['--intent'],
      ['--intent', '--json'],
      ['--limit', '5', '--limit', '6'],
    ]) {
      expect(() => parseRankArgs(argv), JSON.stringify(argv)).toThrow(ScriptExitError);
    }
    // An empty positional is the same missing query.
    expect(() => parseRankArgs(['   '])).toThrow(ScriptExitError);
  });

  it('validates --limit as a bounded positive integer', () => {
    for (const raw of ['NaN', 'abc', '0', '-3', '1.5', '101']) {
      expect(() => parseRankArgs(['q', '--limit', raw]), raw).toThrow(/--limit must be an integer/);
    }
    expect(parseRankArgs(['q', '--limit', '1']).limit).toBe(1);
    expect(parseRankArgs(['q', '--limit', '100']).limit).toBe(100);
  });

  it('keeps scope flags as narrowing inputs with valid values', () => {
    const args = parseRankArgs(['q', '--tenant', 'tenant-a', '--scope', 'repository']);
    expect(args.tenant).toBe('tenant-a');
    expect(args.scope).toBe('repository');
  });

  it('routes JSON output through the shared script printer', () => {
    const source = readTextFile(path.join(pathResolver.rootDir(), 'scripts/context_ranker.ts'));

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
    expect(source).toContain("isRecord, readTextFile } from '@agent/core/foundation'");
  });
});
