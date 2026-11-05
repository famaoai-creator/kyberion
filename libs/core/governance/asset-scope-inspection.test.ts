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
