import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('virtual office output boundary', () => {
  it('routes generation and watch notifications through the harness printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/virtual_office.ts'), { encoding: 'utf8' })
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.stdout');
    expect(source).not.toContain('process.stderr');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
    expect(source).toContain('print(`[virtual-office] refreshed');
  });
});
