import { describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { inspectReadPermission } from '../tier-guard.js';
import type { AssetReadCeiling, AssetStoreDeclaration } from '../contracts/asset-scope.js';
import { inspectAssetScopeRead } from './asset-scope-inspection.js';

const stores: AssetStoreDeclaration[] = [
  {
    id: 'fixture',
    path: 'knowledge/confidential/<tenant>',
    custody: { kind: 'tenant', ref: '<tenant>' },
    tiers: ['confidential'],
    status: 'active',
  },
];
const ceiling: AssetReadCeiling = {
  custodians: [{ kind: 'tenant', ref: 'acme' }],
  readTiers: ['confidential'],
};
const file = pathResolver.rootResolve('knowledge/confidential/acme/file.json');

describe('asset scope read comparison', () => {
  it('reports actual catalog attribution without inferring a ceiling', () => {
    const expected = inspectReadPermission(file);
    const result = inspectAssetScopeRead(file);
    expect(result.decision).toEqual(expected);
    expect(result.shadow).toMatchObject({
      status: 'address_only',
      resolution: { status: 'resolved', address: { custody: { kind: 'tenant', ref: 'acme' } } },
    });
    expect(result.shadow).not.toHaveProperty('observation');
    expect(result.shadow).not.toHaveProperty('agrees');
  });

  it('preserves denied decisions for address-only planned locations without a comparison', () => {
    const decision = { allowed: false, reason: 'existing denial' };
    const result = inspectAssetScopeRead(file, undefined, {
      inspect: () => decision,
      loadStores: () => [{ ...stores[0], status: 'planned' }],
    });
    expect(result.decision).toBe(decision);
    expect(result.shadow).toMatchObject({
      status: 'address_only',
      resolution: { address: { location: 'planned' } },
    });
    expect(result.shadow).not.toHaveProperty('observation');
    expect(result.shadow).not.toHaveProperty('agrees');
    expect(
      inspectAssetScopeRead(file, ceiling, {
        inspect: () => decision,
        loadStores: () => [{ ...stores[0], status: 'planned' }],
      }).shadow
    ).toMatchObject({
      status: 'compared',
      observation: { allowed: false, reason: 'planned_location' },
    });
  });

  it.each([
    ['customer/acme/connections/slack.json', 'tier_unresolved'],
    ['active/missions/public/MSN-X/state.json', 'custody_unresolved'],
    ['unknown-asset-scope-fixture/file.json', 'unknown_store'],
  ])('keeps actual unresolved attribution explicit for %s', (relative, reason) => {
    const result = inspectAssetScopeRead(pathResolver.rootResolve(relative));
    expect(result.shadow).toMatchObject({ status: 'unresolved', resolution: { reason } });
  });

  it('does not compare outside-repository and invalid addresses', () => {
    for (const target of [
      pathResolver.rootResolve('../outside-asset-scope-fixture.json'),
      pathResolver.rootResolve('knowledge/confidential/acme/file%2ejson'),
    ]) {
      const result = inspectAssetScopeRead(target, undefined, {
        inspect: () => ({ allowed: false }),
        loadStores: () => stores,
      });
      expect(result.shadow).toMatchObject({
        status: 'unresolved',
        resolution: { reason: 'invalid_path' },
      });
    }
  });

  it('preserves address-only decisions when the catalog is unavailable', () => {
    const decision = { allowed: false, reason: 'existing denial' };
    expect(
      inspectAssetScopeRead(file, undefined, {
        inspect: () => decision,
        loadStores: () => {
          throw new Error('unavailable catalog');
        },
      })
    ).toEqual({ decision, shadow: { status: 'unavailable' } });
  });

  it('preserves the real inspector result with the real catalog', () => {
    const expected = inspectReadPermission(file);
    const result = inspectAssetScopeRead(file, ceiling);
    expect(result.decision).toEqual(expected);
    expect(result.shadow).toMatchObject({ status: 'compared' });
  });
  it('never turns a legacy denial into permission', () => {
    const decision = {
      allowed: false,
      reason: 'existing denial',
      denialKind: 'tier_restriction' as const,
    };
    const inspect = vi.fn(() => decision);
    const result = inspectAssetScopeRead(file, ceiling, { inspect, loadStores: () => stores });
    expect(result.decision).toBe(decision);
    expect(result.shadow).toMatchObject({
      status: 'compared',
      agrees: false,
      observation: { allowed: true },
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(file, 'read');
  });

  it('does not enforce shadow denial on an existing allow', () => {
    const decision = { allowed: true };
    const result = inspectAssetScopeRead(
      file,
      { ...ceiling, readTiers: [] },
      { inspect: () => decision, loadStores: () => stores }
    );
    expect(result.decision).toBe(decision);
    expect(result.shadow).toMatchObject({
      status: 'compared',
      agrees: false,
      observation: { allowed: false },
    });
  });

  it('preserves the authoritative result on catalog failure', () => {
    const decision = { allowed: true };
    const inspect = vi.fn(() => decision);
    expect(
      inspectAssetScopeRead(file, ceiling, {
        operation: 'metadata',
        inspect,
        loadStores: () => {
          throw new Error('invalid catalog');
        },
      })
    ).toEqual({ decision, shadow: { status: 'unavailable' } });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(file, 'metadata');
  });

  it('reports unresolved addresses without inventing a comparison', () => {
    expect(
      inspectAssetScopeRead(file, ceiling, {
        inspect: () => ({ allowed: false }),
        loadStores: () => [],
      }).shadow
    ).toMatchObject({ status: 'unresolved', resolution: { reason: 'unknown_store' } });
  });

  it('loads and validates the repository catalog through the explicit facade', () => {
    const result = inspectAssetScopeRead(
      pathResolver.rootResolve('knowledge/personal/stances/acme/identity.json'),
      { custodians: [{ kind: 'person', ref: 'installation-owner' }], readTiers: ['personal'] },
      { inspect: () => ({ allowed: false }) }
    );
    expect(result.shadow).toMatchObject({ status: 'compared', observation: { allowed: true } });
    expect(result.decision.allowed).toBe(false);
  });
});
