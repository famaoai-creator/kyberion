import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import {
  loadMediaDrawioTierOrderCatalog,
  resolveMediaDrawioTierRank,
} from './media-drawio-tier-order.js';

describe('media-drawio-tier-order', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(
      pathResolver.rootResolve('libs/shared-media/src/media-drawio-tier-order.ts'),
      {
        encoding: 'utf8',
      }
    ) as string;
    expect(source).not.toContain('FALLBACK_CATALOG');
  });

  it('resolves drawio tier order from knowledge', () => {
    const catalog = loadMediaDrawioTierOrderCatalog();

    expect(catalog.tier_order[0]).toBe('network');
    expect(resolveMediaDrawioTierRank('web')).toBeLessThan(resolveMediaDrawioTierRank('security'));
  });
});
