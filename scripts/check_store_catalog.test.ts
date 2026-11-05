import { describe, expect, it } from 'vitest';
import {
  checkStoreCatalog,
  checkStoreRegistrations,
  normalizePolicyPath,
  owningStore,
  templateCovers,
  type StoreEntry,
  type StoreRootRegistries,
} from './check_store_catalog.js';

const store = (id: string, path: string, extra: Partial<StoreEntry> = {}): StoreEntry => ({
  id,
  path,
  custody: { kind: 'tenant' },
  status: 'active',
  ...extra,
});

describe('runtime store registration coverage', () => {
  const roots: StoreRootRegistries = {
    state: { dot: 'active/shared/runtime/dot' },
    ledger: { resource_usage: 'active/shared/runtime/usage-ledger' },
    floor: { scratch: 'active/shared/tmp' },
  };
  const policies = [
    { path: 'active/shared/runtime/dot' },
    { path: 'active/shared/runtime/usage-ledger' },
    { path: 'active/shared/tmp' },
  ];
  const registered = (): StoreEntry[] => [
    store('dot', 'active/shared/runtime/dot/<tier>/<tenant>', {
      registration: { family: 'state', key: 'dot', retention_path: policies[0].path },
    }),
    // Registering an existing bare-root metrics store must not reinterpret custody.
    store('usage', 'active/shared/runtime/usage-ledger', {
      custody: { kind: 'unscoped-legacy' },
      registration: { family: 'ledger', key: 'resource_usage', retention_path: policies[1].path },
    }),
    store('scratch', 'active/shared/tmp/<tier>/<tenant>', {
      registration: { family: 'floor', key: 'scratch', retention_path: policies[2].path },
    }),
  ];

  it('covers state, ledger and floor registrations without changing legacy custody', () => {
    const stores = registered();
    expect(checkStoreRegistrations(stores, roots, policies)).toEqual([]);
    expect(stores[1].custody.kind).toBe('unscoped-legacy');
  });

  it('detects a missing ledger registration instead of accepting a broad parent store', () => {
    expect(
      checkStoreRegistrations(
        registered()
          .filter(({ id }) => id !== 'usage')
          .concat(store('parent', 'active/shared/runtime')),
        roots,
        policies
      )
    ).toContain('missing store registration ledger:resource_usage');
  });

  it('rejects duplicate and unknown registry keys including inherited property names', () => {
    for (const key of ['unknown', 'constructor', 'toString'])
      expect(
        checkStoreRegistrations(
          [
            ...registered(),
            store('unknown', 'active/unknown', {
              registration: { family: 'state', key, retention_path: policies[0].path },
            }),
          ],
          roots,
          policies
        )
      ).toContain(`unknown: unknown registration state:${key}`);
    const duplicate = { ...registered()[0], id: 'duplicate' };
    expect(checkStoreRegistrations([...registered(), duplicate], roots, policies)).toContain(
      'duplicate: duplicate registration state:dot'
    );
  });

  it('rejects a mismatched or planned physical registration', () => {
    const stores = registered();
    stores[0] = { ...stores[0], path: 'active/shared/runtime/different', status: 'planned' };
    expect(checkStoreRegistrations(stores, roots, policies)).toEqual(
      expect.arrayContaining([
        'dot: registered runtime root must be active',
        'dot: registration state:dot does not match root active/shared/runtime/dot',
      ])
    );
  });

  it('does not lose state/floor tier and tenant bindings by accepting a bare root', () => {
    for (const index of [0, 2]) {
      const stores = registered();
      stores[index] = {
        ...stores[index],
        path: stores[index].path.replace('/<tier>/<tenant>', ''),
      };
      expect(checkStoreRegistrations(stores, roots, policies).join('\n')).toContain(
        'does not match root'
      );
    }
    const stores = registered();
    stores[1].custody = { kind: 'tenant' };
    expect(checkStoreRegistrations(stores, roots, policies).join('\n')).toContain(
      'does not match root'
    );
  });

  it('requires an existing, covering and canonical retention policy reference', () => {
    for (const retention_path of [
      'active/missing',
      '../escape',
      'active/shared/runtime/usage-ledger',
    ]) {
      const stores = registered();
      stores[0].registration = { ...stores[0].registration!, retention_path };
      expect(checkStoreRegistrations(stores, roots, policies).join('\n')).toMatch(
        /retention reference/
      );
    }
  });

  it('uses the existing most-specific root policy and rejects ambiguous references', () => {
    const stores = registered();
    stores[0].registration = {
      ...stores[0].registration!,
      retention_path: 'active/shared/runtime',
    };
    expect(
      checkStoreRegistrations(stores, roots, [...policies, { path: 'active/shared/runtime' }])
    ).toContain(
      'dot: retention reference active/shared/runtime differs from effective root policy active/shared/runtime/dot'
    );
    expect(
      checkStoreRegistrations(registered(), roots, [...policies, policies[0]]).join('\n')
    ).toContain('retention reference active/shared/runtime/dot is ambiguous');
  });

  it('rejects noncanonical root declarations', () => {
    expect(
      checkStoreRegistrations(
        registered(),
        { ...roots, state: { dot: 'active/../runtime/dot' } },
        policies
      ).join('\n')
    ).toContain('noncanonical runtime root');
  });
});

describe('store catalog gate', () => {
  it('normalizes policy placeholders', () => {
    expect(normalizePolicyPath('customer/${KYBERION_TENANT}/deals/')).toBe(
      'customer/<tenant>/deals'
    );
    expect(normalizePolicyPath('customer/${KYBERION_STANCE}/logs/')).toBe('customer/<slug>/logs');
  });

  it('matches placeholders by kind: a stance slug never stands for a tenant', () => {
    expect(templateCovers('customer/<tenant>/deals', 'customer/<tenant>/deals/x.json')).toBe(true);
    expect(templateCovers('customer/<slug>', 'customer/<tenant>/deals')).toBe(false);
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
    expect(templateCovers('customer/<tenant>/deals', 'customer/<tenant>')).toBe(false);
  });

  it('picks the most specific store and ignores planned ones', () => {
    const stores = [
      store('root', 'customer/<tenant>'),
      store('deals', 'customer/<tenant>/deals'),
      store('new', 'customer/<tenant>/deals/x', { status: 'planned' }),
    ];
    expect(owningStore(stores, 'customer/<tenant>/deals/x')?.id).toBe('deals');
    expect(owningStore(stores, 'customer/<tenant>/notes')?.id).toBe('root');
  });

  it('reports missing role coverage, stale role lists, bad moves and unscoped growth', () => {
    const stores = [
      store('deals', 'customer/<tenant>/deals', { legacy_roles: ['old_store'] }),
      store('legacy', 'customer/<slug>', { status: 'legacy-move', moves_to: 'nowhere' }),
      store('loose', 'active/shared/state', { custody: { kind: 'unscoped-legacy' } }),
    ];
    const report = checkStoreCatalog(
      { stores },
      {
        deal_writer: { allow_write: ['customer/${KYBERION_TENANT}/deals/'] },
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
