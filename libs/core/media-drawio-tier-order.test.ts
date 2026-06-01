import { describe, expect, it } from 'vitest';
import { loadMediaDrawioTierOrderCatalog, resolveMediaDrawioTierRank } from './media-drawio-tier-order.js';

describe('media-drawio-tier-order', () => {
  it('resolves drawio tier order from knowledge', () => {
    const catalog = loadMediaDrawioTierOrderCatalog();

    expect(catalog.tier_order[0]).toBe('network');
    expect(resolveMediaDrawioTierRank('web')).toBeLessThan(resolveMediaDrawioTierRank('security'));
  });
});
