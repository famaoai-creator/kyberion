import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { runHistorySearch } from './history_search.js';

describe('history search output boundary', () => {
  it('keeps public history output free of direct process streams', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/history_search.ts'), { encoding: 'utf8' })
    );

    expect(source).not.toContain('process.stdout');
    expect(source).not.toContain('process.stderr');
    expect(source).toContain('runHistorySearch(argv, print)');
  });

  it('routes JSON search output through the supplied printer', () => {
    const output: unknown[] = [];

    expect(
      runHistorySearch(['--json', '--query', '__kyberion_output_boundary_test__'], (value) => {
        output.push(value);
      })
    ).toBe(0);

    expect(output).toHaveLength(1);
    expect(JSON.parse(String(output[0]))).toMatchObject({ results: expect.any(Array) });
  });
});
