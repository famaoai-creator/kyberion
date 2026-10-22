import { describe, expect, it } from 'vitest';
import { runProbes, type DecisionProbeSet } from './probes.js';

const NOW = '2026-09-14T00:00:00.000Z';

const files: Record<string, string> = {
  'src/csv.ts': [
    '// CSV header (SPEC-OLD §6)',
    'const CSV_HEADER = ["a", "b", "c"];',
    'type: "text/csv;charset=utf-8"',
  ].join('\n'),
  'src/memo.ts':
    'export const MEMO_MAX_LENGTH = 15;\nif ([...memo].length > MEMO_MAX_LENGTH) fail();',
  'src/screen.tsx': 'onClick={download}\n<b>x</b>\nonClick={download}',
};

const set: DecisionProbeSet = {
  version: '1.0.0',
  case_id: 'case-a',
  repo: 'impl',
  probes: [
    {
      key: 'csv.columns',
      file: 'src/csv.ts',
      pattern: 'CSV_HEADER\\s*=\\s*(\\[[^\\]]*\\])',
      capture: 'list',
      stale_if: { pattern: 'SPEC-OLD' },
    },
    { key: 'csv.charset', file: 'src/csv.ts', pattern: 'charset=([\\w-]+)"', capture: 'string' },
    {
      key: 'memo.max',
      file: 'src/memo.ts',
      pattern: 'MEMO_MAX_LENGTH\\s*=\\s*(\\d+)',
      capture: 'number',
    },
    {
      key: 'memo.codepoints',
      file: 'src/memo.ts',
      pattern: '\\[\\.\\.\\.\\w+\\]\\.length',
      capture: 'boolean',
    },
    {
      key: 'csv.controls',
      file: 'src/screen.tsx',
      pattern: 'onClick=\\{download\\}',
      capture: 'count',
    },
    { key: 'missing.file', file: 'src/none.ts', pattern: 'x' },
    { key: 'has.readme', file: 'README.md', capture: 'exists', pattern: '' },
    { key: 'no.match', file: 'src/memo.ts', pattern: 'NOT_THERE' },
    { key: 'bad.json', file: 'src/memo.ts', pattern: '(MEMO_MAX_LENGTH)', capture: 'json' },
    { key: 'bad.regex', file: 'src/memo.ts', pattern: '(' },
  ],
};

describe('runProbes', () => {
  it('turns declarative probes into observations with file:line refs, and reports misses', () => {
    const { observed, misses } = runProbes(set, (rel) => files[rel], { commit: 'abc', now: NOW });
    expect(observed.impl).toEqual({ repo: 'impl', commit: 'abc' });
    const byKey = Object.fromEntries(observed.observations.map((o) => [o.key, o]));
    expect(byKey['csv.columns']).toMatchObject({
      value: ['a', 'b', 'c'],
      ref: 'src/csv.ts:2',
      stale: true,
    });
    expect(byKey['csv.charset']).toMatchObject({ value: 'utf-8', ref: 'src/csv.ts:3' });
    expect(byKey['memo.max']).toMatchObject({ value: 15, ref: 'src/memo.ts:1' });
    expect(byKey['memo.codepoints'].value).toBe(true);
    expect(byKey['csv.controls']).toMatchObject({ value: 2, ref: 'src/screen.tsx:1' });
    expect(byKey['has.readme'].value).toBe(false);
    expect(misses).toEqual([
      { key: 'missing.file', reason: 'file_missing', file: 'src/none.ts' },
      { key: 'no.match', reason: 'no_match', file: 'src/memo.ts' },
      { key: 'bad.json', reason: 'bad_json', file: 'src/memo.ts' },
      { key: 'bad.regex', reason: 'bad_regex', file: 'src/memo.ts' },
    ]);
  });
});
