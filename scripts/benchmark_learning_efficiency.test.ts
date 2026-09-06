import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { formatBenchmarkTable } from './benchmark_learning_efficiency.js';

describe('benchmark_learning_efficiency', () => {
  it('formats the benchmark table without bypassing the script printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/benchmark_learning_efficiency.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.table(');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');

    const table = formatBenchmarkTable([
      {
        trialName: 'Trial 1',
        inputText: 'inspect',
        llmCalls: 1,
        duration: 42,
        intentId: 'inspect-workspace-surfaces',
        cacheStatus: 'MISS',
      },
    ]);
    expect(table).toContain('Trial');
    expect(table).toContain('inspect-workspace-surfaces');
    expect(table).toContain('MISS');
  });
});
