import { describe, expect, it } from 'vitest';

import {
  loadMediaSignalEntryPolicyCatalog,
  resolveMediaSignalEntryPolicy,
} from './media-signal-entry-policy.js';

describe('media-signal-entry-policy', () => {
  it('exposes signal entry types and default tones', () => {
    const catalog = loadMediaSignalEntryPolicyCatalog();
    expect(catalog.entry_types.map((entry) => entry.source_key)).toEqual([
      'signals',
      'risks',
      'incidents',
      'controls',
    ]);
    expect(resolveMediaSignalEntryPolicy('risks')?.default_tone).toBe('warning');
    expect(resolveMediaSignalEntryPolicy('incidents')?.signal_type).toBe('incident');
  });
});
