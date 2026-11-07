import { describe, expect, it } from 'vitest';
import type { AssetStoreDeclaration } from '../contracts/asset-scope.js';
import { readJson } from './json.js';
import { resolveAssetAddress, observeAssetReadCeiling } from './asset-address.js';

const runtime: AssetStoreDeclaration = {
  id: 'runtime',
  path: 'active/shared/runtime/example/<tier>/<tenant>',
  custody: { kind: 'tenant', ref: '<tenant>', shared_segment: 'system' },
  tiers: ['public', 'confidential', 'personal'],
  status: 'active',
};
const tenantStore: AssetStoreDeclaration = {
  id: 'tenant',
  path: 'knowledge/confidential/<tenant>',
  custody: { kind: 'tenant', ref: '<tenant>' },
  tiers: ['confidential'],
  status: 'active',
};

describe('migration-independent asset address', () => {
  it('keeps custody and tier stable when only a storage binding changes', () => {
    const old: AssetStoreDeclaration = {
      ...tenantStore,
      id: 'old',
      path: 'customer/<tenant>/design',
      status: 'legacy-move',
      moves_to: 'tenant',
    };
    const before = resolveAssetAddress('customer/acme/design/brand.json', [old, tenantStore]);
    const after = resolveAssetAddress('knowledge/confidential/acme/company/brand.json', [
      old,
      tenantStore,
    ]);
    expect(before.status).toBe('resolved');
    expect(after.status).toBe('resolved');
    if (before.status !== 'resolved' || after.status !== 'resolved')
      throw new Error('unresolved fixture');
    expect(before.address.custody).toEqual(after.address.custody);
    expect(before.address.tier).toBe(after.address.tier);
    expect(before.address.store).toBe('old');
    expect(before.address.movesTo).toBe('tenant');
  });

  it.each([
    '../secret',
    '/knowledge/personal/x',
    'knowledge//personal/x',
    'knowledge/./personal/x',
    'knowledge/personal/../x',
    'C:/secret',
    'knowledge\\personal\\x',
    'knowledge/personal/%2e%2e/x',
    'knowledge/personal/x\0',
  ])('refuses noncanonical path %s', (file) => {
    expect(resolveAssetAddress(file, [runtime])).toMatchObject({
      status: 'unresolved',
      reason: 'invalid_path',
    });
  });

  it('uses segment boundaries and refuses unknown stores', () => {
    expect(resolveAssetAddress('knowledge/confidentiality/acme/x', [tenantStore])).toMatchObject({
      reason: 'unknown_store',
    });
  });

  it('distinguishes system shared partitions from tenant custody', () => {
    expect(
      resolveAssetAddress('active/shared/runtime/example/confidential/shared/x', [runtime])
    ).toMatchObject({
      status: 'resolved',
      address: { custody: { kind: 'system', ref: 'installation' } },
    });
    expect(
      resolveAssetAddress('active/shared/runtime/example/confidential/acme/x', [runtime])
    ).toMatchObject({ status: 'resolved', address: { custody: { kind: 'tenant', ref: 'acme' } } });
    for (const tenant of ['personal', 'public', 'confidential', 'system', 'a']) {
      const result = resolveAssetAddress(`active/shared/runtime/example/confidential/${tenant}/x`, [
        runtime,
      ]);
      // 'system' is a syntactically valid tenant; only 'shared' denotes system custody.
      expect(result.status).toBe(tenant === 'system' ? 'resolved' : 'unresolved');
    }
  });

  it('does not take the first tier in an allowed set or accept an invalid tier', () => {
    expect(
      resolveAssetAddress('active/shared/runtime/example/secret/acme/x', [runtime])
    ).toMatchObject({ reason: 'tier_unresolved' });
    expect(
      resolveAssetAddress('archive/x', [
        { ...runtime, path: 'archive', custody: { kind: 'system' } },
      ])
    ).toMatchObject({ reason: 'tier_unresolved' });
  });

  it('does not infer derived custody from the current execution tenant', () => {
    expect(
      resolveAssetAddress('active/missions/public/MSN-X/state.json', [
        { ...runtime, path: 'active/missions', custody: { kind: 'derived' } },
      ])
    ).toMatchObject({ reason: 'custody_unresolved' });
  });

  it('does not use catalog order to resolve conflicting legacy patterns', () => {
    const person: AssetStoreDeclaration = {
      ...tenantStore,
      id: 'person',
      path: 'customer/<slug>',
      custody: { kind: 'person', ref: 'installation-owner' },
    };
    const tenant = { ...tenantStore, path: 'customer/<tenant>' };
    for (const catalog of [
      [person, tenant],
      [tenant, person],
    ])
      expect(resolveAssetAddress('customer/acme/identity.json', catalog)).toEqual({
        status: 'unresolved',
        reason: 'ambiguous_store',
        stores: ['person', 'tenant'],
      });
  });

  it('can preview planned locations without treating them as admitted', () => {
    const result = resolveAssetAddress('knowledge/confidential/acme/company/brand.json', [
      { ...tenantStore, status: 'planned' },
    ]);
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('unresolved fixture');
    expect(
      observeAssetReadCeiling(result.address, {
        custodians: [{ kind: 'tenant', ref: 'acme' }],
        readTiers: ['confidential'],
      })
    ).toEqual({ allowed: false, reason: 'planned_location' });
  });

  it('applies custody and tier as independent ceilings', () => {
    const result = resolveAssetAddress('knowledge/confidential/acme/file.json', [tenantStore]);
    if (result.status !== 'resolved') throw new Error('unresolved fixture');
    expect(
      observeAssetReadCeiling(result.address, {
        custodians: [{ kind: 'tenant', ref: 'other' }],
        readTiers: ['confidential'],
      }).reason
    ).toBe('custody_denied');
    expect(
      observeAssetReadCeiling(result.address, {
        custodians: [result.address.custody],
        readTiers: ['public'],
      }).reason
    ).toBe('tier_denied');
    expect(
      observeAssetReadCeiling(result.address, {
        custodians: [result.address.custody],
        readTiers: ['confidential'],
      }).allowed
    ).toBe(true);
  });

  it('keeps actual G0 mixed roots unresolved and resolves the S1 home', () => {
    const { stores } = readJson<{ stores: AssetStoreDeclaration[] }>(
      'knowledge/product/governance/store-catalog.json'
    );
    for (const file of [
      'customer/acme/identity.json',
      'customer/acme/connections/slack.json',
      'customer/acme/connections/channel-bindings.json',
    ])
      expect(resolveAssetAddress(file, stores).status).toBe('unresolved');
    expect(
      resolveAssetAddress('knowledge/personal/stances/acme/identity.json', stores)
    ).toMatchObject({
      status: 'resolved',
      address: { custody: { kind: 'person', ref: 'installation-owner' }, tier: 'personal' },
    });
  });
});
