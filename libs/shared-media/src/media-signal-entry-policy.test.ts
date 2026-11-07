import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';

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

  it('keeps the canonical catalog as the only policy definition', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/shared-media/src/media-signal-entry-policy.ts'))
    );

    expect(source).not.toContain('FALLBACK_');
    expect(source).not.toContain('fallback:');
  });
});
