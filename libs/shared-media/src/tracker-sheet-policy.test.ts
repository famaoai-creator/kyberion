import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

import { loadTrackerSheetPolicyCatalog } from './tracker-sheet-policy.js';

describe('tracker-sheet-policy', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(
      pathResolver.rootResolve('libs/shared-media/src/tracker-sheet-policy.ts'),
      {
        encoding: 'utf8',
      }
    ) as string;
    expect(source).not.toContain('FALLBACK_CATALOG');
  });

  it('exposes tracker sheet titles and empty summary message', () => {
    const catalog = loadTrackerSheetPolicyCatalog();
    expect(catalog.sheet_titles.overview).toBe('Overview');
    expect(catalog.sheet_titles.execution_board).toBe('Execution Board');
    expect(catalog.sheet_titles.signals).toBe('Signals and Risks');
    expect(catalog.summary_empty_message).toBe('No summary cards provided.');
  });
});
