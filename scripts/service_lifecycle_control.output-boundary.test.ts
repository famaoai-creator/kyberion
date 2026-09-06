import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('service lifecycle CLI output boundary', () => {
  it('routes service selection and operation results through the harness printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/service_lifecycle_control.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
  });
});
