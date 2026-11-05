import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

import {
  resolveDocumentContentsLabel,
  resolveDocumentContentsSubtitle,
} from './document-contents-policy.js';

describe('document-contents-policy', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(
      pathResolver.rootResolve('libs/shared-media/src/document-contents-policy.ts'),
      {
        encoding: 'utf8',
      }
    ) as string;
    expect(source).not.toContain('FALLBACK_CATALOG');
  });

  it('returns locale aware labels from the policy', () => {
    expect(resolveDocumentContentsLabel('ja-JP')).toBe('目次');
    expect(resolveDocumentContentsLabel('en-US')).toBe('Contents');
    expect(resolveDocumentContentsSubtitle()).toBe('Document navigation');
  });
});
