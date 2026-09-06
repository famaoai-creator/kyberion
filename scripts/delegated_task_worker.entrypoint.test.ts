import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('delegated task worker script boundary', () => {
  it('routes worker errors through the shared script printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/delegated_task_worker.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ argv, print }) => runWorker(argv, print)');
  });
});
