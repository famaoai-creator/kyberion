import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { getDeal, loadDealAtPath, loadPriceBook, openDeal } from './deal-store.js';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

describe('deal-store price book loader', () => {
  const rootDir = pathResolver.sharedTmp('deal-store-price-book-tests');
  const dealTenant = 'deal-loader-test';

  afterEach(() => {
    safeRmSync(rootDir, { recursive: true, force: true });
    withExecutionContext('mission_controller', () =>
      safeRmSync(pathResolver.rootResolve(`customer/${dealTenant}`), {
        recursive: true,
        force: true,
      })
    );
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

  it('loads a valid deal through the canonical tenant and filename binding', () => {
    const deal = withExecutionContext('mission_controller', () =>
      openDeal({
        tenantSlug: dealTenant,
        surface: 'test',
        channelId: 'channel-1',
        summary: 'canonical deal',
      })
    );
    const filePath = pathResolver.rootResolve(`customer/${dealTenant}/deals/${deal.deal_id}.json`);

    expect(loadDealAtPath(filePath, dealTenant, deal.deal_id)).toEqual(deal);

    withExecutionContext('mission_controller', () =>
      safeWriteFile(filePath, JSON.stringify({ ...deal, tenant_slug: 'other-tenant' }))
    );
    expect(() => loadDealAtPath(filePath, dealTenant, deal.deal_id)).toThrow(
      'deal record binding mismatch'
    );
    expect(getDeal(dealTenant, deal.deal_id)).toBeNull();
  });

  it('rejects a directory at the persisted deal path', () => {
    const filePath = pathResolver.rootResolve(`customer/${dealTenant}/deals/DEAL-DIRECTORY.json`);
    withExecutionContext('mission_controller', () => safeMkdir(filePath, { recursive: true }));
    try {
      expect(() => loadDealAtPath(filePath, dealTenant, 'DEAL-DIRECTORY')).toThrow(
        'deal must be a regular file'
      );
    } finally {
      withExecutionContext('mission_controller', () =>
        safeRmSync(pathResolver.rootResolve(`customer/${dealTenant}`), {
          recursive: true,
          force: true,
        })
      );
    }
  });
});
