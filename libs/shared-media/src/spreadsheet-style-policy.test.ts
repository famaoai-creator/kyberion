import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import {
  loadSpreadsheetStylePolicyCatalog,
  resolveSpreadsheetStyleIndex,
} from './spreadsheet-style-policy.js';

describe('spreadsheet-style-policy', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(
      pathResolver.rootResolve('libs/shared-media/src/spreadsheet-style-policy.ts'),
      {
        encoding: 'utf8',
      }
    ) as string;
    expect(source).not.toContain('FALLBACK_CATALOG');
  });

  it('resolves spreadsheet style indices from knowledge', () => {
    const catalog = loadSpreadsheetStylePolicyCatalog();

    expect(catalog.role_indices.title).toBe(1);
    expect(resolveSpreadsheetStyleIndex('warning')).toBe(7);
    expect(resolveSpreadsheetStyleIndex('body')).toBe(9);
    expect(resolveSpreadsheetStyleIndex('unknown-role')).toBe(0);
  });
});
