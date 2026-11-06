import { describe, expect, it } from 'vitest';
import {
  checkStoreCatalog,
  normalizePolicyPath,
  owningStore,
  templateCovers,
  type StoreEntry,
} from './check_store_catalog.js';

const store = (id: string, path: string, extra: Partial<StoreEntry> = {}): StoreEntry => ({
  id,
  path,
  custody: { kind: 'tenant' },
  status: 'active',
  ...extra,
});

describe('store catalog gate', () => {
  it('normalizes policy placeholders', () => {
    expect(normalizePolicyPath('knowledge/confidential/${KYBERION_TENANT}/deals/')).toBe(
      'knowledge/confidential/<tenant>/deals'
    );
    expect(normalizePolicyPath('customer/${KYBERION_STANCE}/logs/')).toBe('customer/<slug>/logs');
  });

  it('matches placeholders by kind: a stance slug never stands for a tenant', () => {
    expect(
      templateCovers(
        'knowledge/confidential/<tenant>/deals',
        'knowledge/confidential/<tenant>/deals/x.json'
      )
    ).toBe(true);
    expect(templateCovers('customer/<slug>', 'knowledge/confidential/<tenant>/deals')).toBe(false);
    expect(templateCovers('runtime/dot/<tier>/<tenant>', 'runtime/dot/confidential/<tenant>')).toBe(
      true
    );
    expect(templateCovers('runtime/dot/<tier>/<tenant>', 'runtime/dot/confidential/shared')).toBe(
      true
    );
    // a grant on the root or on one tier covers the partitioned template below it
    expect(templateCovers('active/shared/tmp/<tier>/<tenant>', 'active/shared/tmp')).toBe(true);
    expect(templateCovers('active/shared/tmp/<tier>/<tenant>', 'active/shared/tmp/personal')).toBe(
      true
    );
    expect(templateCovers('knowledge/confidential/<tenant>/deals', 'customer/<tenant>')).toBe(
      false
    );
  });

  it('picks the most specific store and ignores planned ones', () => {
    const stores = [
      store('root', 'customer/<tenant>'),
      store('deals', 'knowledge/confidential/<tenant>/deals'),
      store('new', 'knowledge/confidential/<tenant>/deals/x', { status: 'planned' }),
    ];
    expect(owningStore(stores, 'knowledge/confidential/<tenant>/deals/x')?.id).toBe('deals');
    expect(owningStore(stores, 'customer/<tenant>/notes')?.id).toBe('root');
  });

  it('reports missing role coverage, stale role lists, bad moves and unscoped growth', () => {
    const stores = [
      store('deals', 'knowledge/confidential/<tenant>/deals', { legacy_roles: ['old_store'] }),
      store('legacy', 'customer/<slug>', { status: 'legacy-move', moves_to: 'nowhere' }),
      store('loose', 'active/shared/state', { custody: { kind: 'unscoped-legacy' } }),
    ];
    const report = checkStoreCatalog(
      { stores },
      {
        deal_writer: { allow_write: ['knowledge/confidential/${KYBERION_TENANT}/deals/'] },
        stray_reader: { allow_read: ['active/elsewhere/'] },
        mission_controller: { allow_write: ['active/elsewhere/'] },
      },
      { unscoped_legacy: 0 }
    );
    expect(report.unscoped).toBe(1);
    expect(report.violations).toEqual(
      expect.arrayContaining([
        'deals: legacy_roles [old_store] should be [deal_writer] (from knowledge/product/governance/security-policy.json)',
        'legacy: legacy-move needs moves_to naming an existing store',
        'stray_reader: policy path active/elsewhere/ reaches no catalog store',
        expect.stringContaining('unscoped-legacy stores grew from 0 to 1'),
      ])
    );
    // non-store roles are not catalogued
    expect(report.violations.join('\n')).not.toContain('mission_controller');
  });
});
