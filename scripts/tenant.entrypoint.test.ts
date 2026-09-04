import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { main } from './tenant.js';

describe('tenant CLI output boundary', () => {
  it('keeps tenant governance output free of direct console output', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/tenant.ts'), { encoding: 'utf8' })
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('process.stdout');
    expect(source).not.toContain('process.stderr');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
  });

  it('routes help output through the supplied printer', () => {
    const output: unknown[] = [];

    main(['help'], (value) => output.push(value));

    expect(output).toHaveLength(1);
    expect(String(output[0])).toContain('Usage: pnpm tenant');
  });
});
