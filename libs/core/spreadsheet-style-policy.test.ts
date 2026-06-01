import { describe, expect, it } from 'vitest';
import {
  loadSpreadsheetStylePolicyCatalog,
  resolveSpreadsheetStyleIndex,
} from './spreadsheet-style-policy.js';

describe('spreadsheet-style-policy', () => {
  it('resolves spreadsheet style indices from knowledge', () => {
    const catalog = loadSpreadsheetStylePolicyCatalog();

    expect(catalog.role_indices.title).toBe(1);
    expect(resolveSpreadsheetStyleIndex('warning')).toBe(7);
    expect(resolveSpreadsheetStyleIndex('body')).toBe(9);
  });
});
