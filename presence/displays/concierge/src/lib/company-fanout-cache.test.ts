import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_FANOUT_TTL_MS,
  companyFanoutCacheSize,
  invalidateCompanyFanoutCache,
  readThroughCompanyFanoutCache,
  withCompanyFanoutInvalidation,
} from './company-fanout-cache';
import { companyFanoutViews } from './company-fanout-views';
import type { ConciergeViewerContext } from './viewer-context';

function viewer(overrides: Partial<ConciergeViewerContext> = {}): ConciergeViewerContext {
  return {
    role: 'localadmin',
    tenantSlugs: ['acme'],
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['confidential', 'public'],
    source: 'token',
    principalId: 'human:a',
    ...overrides,
  } as ConciergeViewerContext;
}

beforeEach(() => invalidateCompanyFanoutCache());

describe('company fan-out cache', () => {
  it('reuses a read for the same viewer and scope within the TTL only', () => {
    const read = vi.fn(() => ({ n: read.mock.calls.length }));
    expect(readThroughCompanyFanoutCache(viewer(), 'home:20', read, 1_000)).toEqual({ n: 1 });
    expect(
      readThroughCompanyFanoutCache(viewer(), 'home:20', read, 1_000 + COMPANY_FANOUT_TTL_MS - 1)
    ).toEqual({ n: 1 });
    expect(
      readThroughCompanyFanoutCache(viewer(), 'home:20', read, 1_000 + COMPANY_FANOUT_TTL_MS)
    ).toEqual({ n: 2 });
  });

  it('keys by principal and every scope field, and never caches without a principal', () => {
    const read = vi.fn(() => ({}));
    readThroughCompanyFanoutCache(viewer(), 'home:20', read, 0);
    readThroughCompanyFanoutCache(viewer({ principalId: 'human:b' }), 'home:20', read, 0);
    readThroughCompanyFanoutCache(viewer({ tenantSlugs: ['other'] }), 'home:20', read, 0);
    readThroughCompanyFanoutCache(
      viewer({ tenantSlugs: [], includeUntenanted: true }),
      'home:20',
      read,
      0
    );
    readThroughCompanyFanoutCache(viewer({ tierAccess: ['public'] }), 'home:20', read, 0);
    readThroughCompanyFanoutCache(viewer(), 'home:50', read, 0);
    expect(read).toHaveBeenCalledTimes(6);
    readThroughCompanyFanoutCache(viewer({ principalId: undefined }), 'home:20', read, 0);
    readThroughCompanyFanoutCache(viewer({ principalId: undefined }), 'home:20', read, 0);
    expect(read).toHaveBeenCalledTimes(8);
  });

  it('a wrapped mutation clears the cache even when it fails', async () => {
    readThroughCompanyFanoutCache(viewer(), 'home:20', () => ({}), Date.now());
    expect(companyFanoutCacheSize()).toBe(1);
    await expect(
      withCompanyFanoutInvalidation(async () => {
        throw new Error('decision failed');
      })()
    ).rejects.toThrow('decision failed');
    expect(companyFanoutCacheSize()).toBe(0);
  });
});

describe('companyFanoutViews', () => {
  it('narrows each company to exactly that tenant and adds the system view for all-company viewers', () => {
    const views = companyFanoutViews(viewer({ tenantSlugs: 'all', includeUntenanted: true }), [
      'acme',
      'famao-ai',
    ]);
    expect(
      views.companies.map((c) => [c.tenantSlug, c.viewer.tenantSlugs, c.viewer.includeUntenanted])
    ).toEqual([
      ['acme', ['acme'], undefined],
      ['famao-ai', ['famao-ai'], undefined],
    ]);
    expect(views.system).toMatchObject({ tenantSlugs: [], includeUntenanted: true });
  });

  it('never reads a company outside the viewer scope, and no system view for a scoped viewer', () => {
    const views = companyFanoutViews(viewer({ tenantSlugs: ['acme'] }), ['acme', 'famao-ai']);
    expect(views.companies.map((c) => c.tenantSlug)).toEqual(['acme']);
    expect(views.system).toBeUndefined();
  });
});
