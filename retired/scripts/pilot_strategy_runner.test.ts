import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('pilot strategy runner output boundary', () => {
  it('routes strategy completion output through the shared printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/pilot_strategy_runner.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run({ print })');
    expect(source).toContain('return main(print)');
  });
});
