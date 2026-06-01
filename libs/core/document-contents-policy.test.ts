import { describe, expect, it } from 'vitest';

import { resolveDocumentContentsLabel, resolveDocumentContentsSubtitle } from './document-contents-policy.js';

describe('document-contents-policy', () => {
  it('returns locale aware labels from the policy', () => {
    expect(resolveDocumentContentsLabel('ja-JP')).toBe('目次');
    expect(resolveDocumentContentsLabel('en-US')).toBe('Contents');
    expect(resolveDocumentContentsSubtitle()).toBe('Document navigation');
  });
});
