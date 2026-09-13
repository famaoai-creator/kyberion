import { describe, expect, it } from 'vitest';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';

describe('browser session ownership', () => {
  it('rejects a retained session bound to another scope', () => {
    expect(() =>
      browserRuntimeHelpers.assertBrowserSessionOwner(
        'confidential:tenant-a',
        'confidential:tenant-b'
      )
    ).toThrow('[BROWSER_SESSION_OWNER_MISMATCH]');
  });

  it('rejects legacy metadata without an owner binding', () => {
    expect(() =>
      browserRuntimeHelpers.assertBrowserSessionOwner(undefined, 'confidential:tenant-a')
    ).toThrow('[BROWSER_SESSION_OWNER_MISMATCH]');
  });

  it('accepts the exact tier and tenant binding', () => {
    expect(() =>
      browserRuntimeHelpers.assertBrowserSessionOwner('personal:tenant-a', 'personal:tenant-a')
    ).not.toThrow();
  });
});
