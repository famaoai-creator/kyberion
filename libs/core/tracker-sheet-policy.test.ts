import { describe, expect, it } from 'vitest';

import { loadTrackerSheetPolicyCatalog } from './tracker-sheet-policy.js';

describe('tracker-sheet-policy', () => {
  it('exposes tracker sheet titles and empty summary message', () => {
    const catalog = loadTrackerSheetPolicyCatalog();
    expect(catalog.sheet_titles.overview).toBe('Overview');
    expect(catalog.sheet_titles.execution_board).toBe('Execution Board');
    expect(catalog.sheet_titles.signals).toBe('Signals and Risks');
    expect(catalog.summary_empty_message).toBe('No summary cards provided.');
  });
});
