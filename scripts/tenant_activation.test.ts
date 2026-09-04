import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { main } from './tenant_activation.js';

describe('tenant activation output boundary', () => {
  it('routes help output through the injected printer', () => {
    const output: unknown[] = [];

    main(['help'], (value) => output.push(value));

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('Tenant activation gate');
  });

  it('does not keep a direct console output fallback', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/tenant_activation.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
  });
});
