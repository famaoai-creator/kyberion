import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  listSeamSelectionPolicies,
  seamPolicyDefaultChain,
} from './provider/seam-provider-selection.js';

/**
 * One source for a seam's default: the governed policy file. These checks
 * keep `default_provider`, `default_chains` and the policy index coherent so
 * the selection engine, provider chain routers and the `seam select defaults`
 * CLI agree on what "the default" is.
 */
describe('seam selection policies are internally consistent', () => {
  const policies = listSeamSelectionPolicies();

  it('every policy is listed in the index exactly once', () => {
    const index = JSON.parse(
      safeReadFile(
        pathResolver.knowledge('product/governance/seam-provider-selection/index.json'),
        { encoding: 'utf8' }
      ) as string
    ) as { order: string[] };
    expect(new Set(index.order).size).toBe(index.order.length);
    expect([...index.order].sort()).toEqual(policies.map((policy) => policy.seam_id).sort());
  });

  for (const policy of policies) {
    describe(policy.seam_id, () => {
      const providers = Object.keys(policy.providers);

      it('declares its default provider as a profiled provider', () => {
        expect(providers).toContain(policy.default_provider);
      });

      it('lists only profiled providers in default chains', () => {
        for (const [key, chain] of Object.entries(policy.default_chains ?? {})) {
          for (const id of chain) expect(providers, `${key} → ${id}`).toContain(id);
          expect(new Set(chain).size, `${key} has duplicates`).toBe(chain.length);
        }
      });

      it('keeps default_provider inside the default chain (first eligible wins)', () => {
        expect(seamPolicyDefaultChain(policy)).toContain(policy.default_provider);
      });

      it('names a declared fallback purpose', () => {
        if (policy.fallback_purpose) {
          expect(Object.keys(policy.purposes)).toContain(policy.fallback_purpose);
        }
      });
    });
  }
});
