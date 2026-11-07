import { describe, expect, it } from 'vitest';
import {
  STORE_GRANT_IDS,
  registerStoreGrant,
  storeGrantRule,
  storeGrantRules,
} from './store-grant-registry.js';

// G3: the registry is sealed (tests/store-grant-registry-boundary.test.ts restricts who may
// register); a forged or second registration of a store grant id is refused.
describe('Store grant registry', () => {
  it('is sealed: unknown ids and second registrations are refused', () => {
    expect(() => registerStoreGrant({ id: 'zz-forged' as never, authorizes: () => true })).toThrow(
      /STORE_GRANT_UNKNOWN/
    );
    // Loading a grant module registers its id; a lookalike registration of that id is refused.
    return import('./dot-result-store-capability.js').then(() => {
      expect(storeGrantRule('dot-result')).toBeDefined();
      expect(() => registerStoreGrant({ id: 'dot-result', authorizes: () => true })).toThrow(
        /STORE_GRANT_DUPLICATE/
      );
    });
  });

  it('returns frozen rules in the declared evaluation order', async () => {
    await import('./pr-publication-store-capability.js');
    await import('../knowledge/memory-provenance-capability.js');
    const order = storeGrantRules().map((rule) => STORE_GRANT_IDS.indexOf(rule.id));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const rule of storeGrantRules()) expect(Object.isFrozen(rule)).toBe(true);
  });
});
