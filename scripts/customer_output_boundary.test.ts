import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';

describe('customer script output boundary', () => {
  it('keeps customer create and switch free of direct console output', () => {
    for (const file of ['scripts/customer_create.ts', 'scripts/customer_switch.ts']) {
      const source = String(safeReadFile(pathResolver.rootResolve(file)));
      expect(source).not.toContain('console.log');
      expect(source).not.toContain('console.error');
    }
  });
});
