import { describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import type { AssetStoreDeclaration } from '../contracts/asset-scope.js';
import { readJson } from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';
import { assetReadCeilingFor, declaredReadTiers } from './asset-read-ceiling.js';
import { loadAuthorityRoleIndex } from '../organization/authority-role-registry.js';
import { inspectAssetScopeRead } from './asset-scope-inspection.js';

const stores = readJson<{ stores: Array<AssetStoreDeclaration & { path: string }> }>(
  pathResolver.knowledge('product/governance/store-catalog.json')
).stores;
const roleIndex = loadAuthorityRoleIndex();

/** The guard's decision and the catalog ceiling's observation, inside one identity. */
function compare(role: string, tenant: string | undefined, relative: string) {
  return withExecutionContext(
    role,
    () => {
      const result = inspectAssetScopeRead(
        pathResolver.rootResolve(relative),
        assetReadCeilingFor(undefined, () => roleIndex),
        { loadStores: () => stores }
      );
      return {
        guard: result.decision.allowed,
        ceiling: result.shadow.status === 'compared' ? result.shadow.observation.allowed : null,
        status: result.shadow.status,
      };
    },
    'worker',
    tenant
  );
}

describe('asset read ceiling (G1, decide step 1)', () => {
  it('is built from the server-resolved tenant binding only', () => {
    expect(assetReadCeilingFor({ tenantSlug: undefined })).toBeUndefined();
    expect(assetReadCeilingFor({ tenantSlug: 'public' })).toBeUndefined();
    expect(
      assetReadCeilingFor({ tenantSlug: 'acme', brokeredTenants: ['beta', 'shared'] })
    ).toEqual({
      custodians: [
        { kind: 'tenant', ref: 'acme' },
        { kind: 'tenant', ref: 'beta' },
        { kind: 'system', ref: 'installation' },
        { kind: 'person', ref: 'installation-owner' },
      ],
      readTiers: ['public', 'confidential', 'personal'],
    });
  });

  it.each([
    // [role, bound tenant, deal of tenant, guard allows]
    ['customer_decision_deal_note_writer', 'acme', 'acme', true],
    ['customer_decision_deal_note_writer', 'beta', 'acme', false],
    ['mission_controller', 'acme', 'acme', true],
    ['mission_controller', 'beta', 'acme', false],
  ])('tenant-deals: %s bound to %s reading a %s deal', (role, bound, owner, guardAllows) => {
    const result = compare(role, bound, `knowledge/confidential/${owner}/deals/DEAL-1.json`);
    expect(result.status).toBe('compared');
    expect(result.guard).toBe(guardAllows);
    // The ceiling is an upper bound: whatever the guard allows lies inside it,
    // and it denies exactly the other tenant's records.
    expect(result.ceiling).toBe(bound === owner);
  });

  it('never lets the guard allow a cross-tenant read the ceiling denies', () => {
    const allowedOutsideCeiling: string[] = [];
    for (const store of stores) {
      if (store.status !== 'active' || store.custody.kind !== 'tenant') continue;
      // Public-tier tenant data is not tenant-scoped by design (tier is the
      // disclosure ceiling); only personal and confidential are compared.
      const tiers = store.path.includes('<tier>')
        ? ['personal', 'confidential']
        : (store.tiers ?? []).filter((tier) => tier !== 'public');
      for (const tier of tiers) {
        const relative = `${store.path
          .replace('<tier>', tier)
          .replace('<tenant>', 'acme')
          .replace(/<[a-z]+>/gu, 'x1')}/item.json`;
        const result = compare('mission_controller', 'beta', relative);
        if (result.status === 'compared' && result.guard && result.ceiling === false)
          allowedOutsideCeiling.push(`${store.id}:${tier}`);
      }
    }
    // G2 closed the three unprotected partitions this sweep found.
    expect(allowedOutsideCeiling).toEqual([]);
  });

  it('takes the tier ceiling from the role declaration, public always included', () => {
    const roles = () => ({ reader: { tier_access: ['confidential'] }, none: {} });
    expect(declaredReadTiers('reader', roles)).toEqual(['public', 'confidential']);
    expect(declaredReadTiers('none', roles)).toEqual(['public', 'confidential', 'personal']);
    expect(declaredReadTiers(undefined, roles)).toEqual(['public', 'confidential', 'personal']);
  });

  it('never lets the guard read a tier a role does not declare, except the known classes', () => {
    // Accepted for now, each for a recorded reason (G2):
    // - stance-logs: declared personal, but lives on the public logs floor;
    // - runtime.surface-management: like the floors, the bound tenant's partition is
    //   readable by any role bound to that tenant (runtime default read);
    // - tenant floors: the bound tenant's scratch, staging and cache partitions are
    //   readable by any role bound to that tenant, whatever the role's tiers.
    const known = new Set([
      'stance-logs',
      'runtime.surface-management',
      'floor.cache',
      'floor.scratch',
      'floor.staging',
    ]);
    const outside: string[] = [];
    for (const role of Object.keys(roleIndex).sort()) {
      for (const store of stores) {
        if (store.status !== 'active') continue;
        // Public is inside every ceiling by construction; compare the protected tiers only.
        const tiers = store.path.includes('<tier>')
          ? ['personal', 'confidential']
          : store.tiers?.includes('public') && store.tiers.length === 1
            ? []
            : [''];
        for (const tier of tiers) {
          const relative = `${store.path
            .replace('<tier>', tier)
            .replace('<tenant>', 'acme')
            .replace('<slug>', 'me')
            .replace(/<[a-z]+>/gu, 'x1')}/item.json`;
          let result: ReturnType<typeof compare>;
          try {
            result = compare(role, 'acme', relative);
          } catch {
            continue; // a role that cannot be bound to this tenant reads nothing here
          }
          if (
            result.status === 'compared' &&
            result.guard &&
            result.ceiling === false &&
            !known.has(store.id)
          )
            outside.push(`${role}:${store.id}:${tier}`);
        }
      }
    }
    expect(outside).toEqual([]);
  }, 120_000);
});
