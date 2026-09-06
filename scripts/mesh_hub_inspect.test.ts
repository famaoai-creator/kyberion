import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';

describe('mesh hub inspection output boundary', () => {
  it('keeps report output behind the injected printer', () => {
    const source = String(safeReadFile(pathResolver.rootResolve('scripts/mesh_hub_inspect.ts')));

    expect(source).toContain('print: Print');
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('process.stdout');
  });
});
