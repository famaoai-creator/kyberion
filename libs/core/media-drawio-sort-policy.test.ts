import { describe, expect, it } from 'vitest';
import {
  loadMediaDrawioSortPolicyCatalog,
  resolveMediaDrawioGroupRank,
  resolveMediaDrawioTypeRank,
} from './media-drawio-sort-policy.js';

describe('media-drawio-sort-policy', () => {
  it('resolves group and type order from knowledge', () => {
    const catalog = loadMediaDrawioSortPolicyCatalog();

    expect(catalog.group_order[0]).toBe('edge');
    expect(resolveMediaDrawioGroupRank('web')).toBeLessThan(resolveMediaDrawioGroupRank('security'));
    expect(resolveMediaDrawioTypeRank('aws_provider')).toBeLessThan(resolveMediaDrawioTypeRank('aws_s3_bucket'));
  });
});
