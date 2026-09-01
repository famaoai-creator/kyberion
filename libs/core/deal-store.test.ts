import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { getDeal, loadPriceBook, openDeal } from './deal-store.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

describe('deal-store price book loader', () => {
  const rootDir = pathResolver.sharedTmp('deal-store-price-book-tests');

  afterEach(() => {
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  it('skips a schema-invalid tenant price book and loads the public catalog', () => {
    const tenantDir = path.join(rootDir, 'knowledge/confidential/acme/sales');
    const publicDir = path.join(rootDir, 'knowledge/product/sales');
    safeMkdir(tenantDir, { recursive: true });
    safeMkdir(publicDir, { recursive: true });
    safeWriteFile(
      path.join(tenantDir, 'price-book.json'),
      JSON.stringify({ version: '1.0.0', currency: 'JPY', items: [{ sku: 'bad' }] })
    );
    safeWriteFile(
      path.join(publicDir, 'price-book.json'),
      JSON.stringify({
        version: '1.0.0',
        currency: 'JPY',
        items: [{ sku: 'standard', name: 'Standard', unit: 'hour', unit_price: 1000 }],
      })
    );

    const priceBook = loadPriceBook('acme', rootDir);

    expect(priceBook?.items[0]?.sku).toBe('standard');
  });

  it('does not resolve an invalid tenant slug into a tenant path', () => {
    const publicDir = path.join(rootDir, 'knowledge/product/sales');
    safeMkdir(publicDir, { recursive: true });
    safeWriteFile(
      path.join(publicDir, 'price-book.json'),
      JSON.stringify({
        version: '1.0.0',
        currency: 'JPY',
        items: [{ sku: 'public', name: 'Public', unit: 'hour', unit_price: 1000 }],
      })
    );

    const priceBook = loadPriceBook('../secret', rootDir);

    expect(priceBook?.items[0]?.sku).toBe('public');
  });

  it('rejects invalid tenant slugs before opening a durable deal record', () => {
    expect(() =>
      openDeal({
        tenantSlug: '../outside',
        surface: 'test',
        channelId: 'channel-1',
        summary: 'should not be written',
      })
    ).toThrow('[DEAL_SCOPE]');
  });

  it('rejects traversal-shaped deal ids before reading a durable deal record', () => {
    expect(() => getDeal('acme', '../outside')).toThrow('[DEAL_SCOPE]');
  });
});
