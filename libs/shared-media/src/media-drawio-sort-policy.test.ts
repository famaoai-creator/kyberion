import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import {
  loadMediaDrawioSortPolicyCatalog,
  resolveMediaDrawioGroupRank,
  resolveMediaDrawioTypeRank,
} from './media-drawio-sort-policy.js';

describe('media-drawio-sort-policy', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(
      pathResolver.rootResolve('libs/shared-media/src/media-drawio-sort-policy.ts'),
      {
        encoding: 'utf8',
      }
    ) as string;
    expect(source).not.toContain('FALLBACK_CATALOG');
  });

  it('resolves group and type order from knowledge', () => {
    const catalog = loadMediaDrawioSortPolicyCatalog();

    expect(catalog.group_order[0]).toBe('edge');
    expect(resolveMediaDrawioGroupRank('web')).toBeLessThan(
      resolveMediaDrawioGroupRank('security')
    );
    expect(resolveMediaDrawioTypeRank('aws_provider')).toBeLessThan(
      resolveMediaDrawioTypeRank('aws_s3_bucket')
    );
  });
});
