import { describe, expect, it } from 'vitest';
import { checkFiniteStateSafety, type SafetyModel } from '../testing/finite-state-checker.js';
import {
  narrowSurfaceViewerTier,
  resolveSurfaceViewerTierAccess,
  SurfaceViewerScopeError,
} from './surface-mutation-guard.js';
import type { ChronosAccessRole } from '../authn/chronos-access-registry.js';
import type { OsKnowledgeTier } from '../governance/cloudflare-os-control-plane.js';

const roles: ChronosAccessRole[] = ['readonly', 'localadmin'];
const tiers: OsKnowledgeTier[] = ['public', 'confidential', 'personal'];
const subsets = Array.from({ length: 8 }, (_, mask) => mask);
// A resolved cap is authoritative at narrowing. Role policy is checked by the
// resolver, separately; it is not a fallback when a resolved cap is empty.
const contains = (mask: number, requested: number) => (mask & (1 << requested)) !== 0;
const members = (mask: number) => tiers.filter((_tier, index) => contains(mask, index));
const roleDefaults: Record<ChronosAccessRole, number> = { readonly: 0b011, localadmin: 0b111 };

interface State {
  role: ChronosAccessRole;
  mask: number;
  requested: number;
  admitted: boolean;
}
function state(role: ChronosAccessRole, mask: number, requested: number, broken = false): State {
  const effectiveMask = broken && mask === 0 ? roleDefaults[role] : mask;
  return { role, mask, requested, admitted: contains(effectiveMask, requested) };
}
function model(broken = false): SafetyModel<State> {
  return {
    initial: roles.flatMap((role) =>
      tiers.map((_tier, requested) => state(role, 7, requested, broken))
    ),
    key: JSON.stringify,
    next: (current) =>
      tiers.flatMap((_tier, index) =>
        contains(current.mask, index)
          ? [
              {
                action: `remove:${tiers[index]}`,
                state: state(current.role, current.mask & ~(1 << index), current.requested, broken),
              },
            ]
          : []
      ),
    invariants: {
      'explicit cap limits admission': (current) =>
        current.admitted === contains(current.mask, current.requested),
    },
  };
}
function observed(
  viewer: Parameters<typeof narrowSurfaceViewerTier>[0],
  tier: OsKnowledgeTier
): boolean {
  try {
    expect(narrowSurfaceViewerTier(viewer, tier)).toBe(tier);
    return true;
  } catch (error) {
    if (!(error instanceof SurfaceViewerScopeError)) throw error;
    expect(error.status).toBe(403);
    return false;
  }
}

describe('viewer tier finite subset model', () => {
  it('exhausts both roles, all tier subsets and every requested tier', () => {
    expect(checkFiniteStateSafety(model())).toEqual({
      status: 'verified',
      visited: 48,
      transitions: 72,
    });
  });

  it('detects the empty-cap/default-role mutation after removing all grants', () => {
    const result = checkFiniteStateSafety(model(true));
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('explicit cap limits admission');
    expect(result.trace).toHaveLength(4);
    expect(result.trace?.at(-1)?.state).toMatchObject({ mask: 0, admitted: true });
  });

  const cases = roles.flatMap((role) =>
    subsets.flatMap((mask) => tiers.map((tier, requested) => ({ role, mask, tier, requested })))
  );
  it.each(cases)(
    'matches membership for $role cap=$mask request=$tier',
    ({ role, mask, tier, requested }) => {
      expect(observed({ role, tierAccess: members(mask) }, tier)).toBe(contains(mask, requested));
    }
  );

  it('removing grants never changes denial into allowance across all 162 subset comparisons', () => {
    let comparisons = 0;
    for (const role of roles) {
      for (const broader of subsets) {
        for (const narrower of subsets) {
          if ((narrower & broader) !== narrower) continue;
          for (const tier of tiers) {
            const before = observed({ role, tierAccess: members(broader) }, tier);
            const after = observed({ role, tierAccess: members(narrower) }, tier);
            expect(!after || before, `${role}: ${broader} -> ${narrower}, ${tier}`).toBe(true);
            comparisons++;
          }
        }
      }
    }
    expect(comparisons).toBe(162);
  });

  it('keeps upstream role policy resolution separate from resolved-cap membership', () => {
    for (const role of roles) {
      expect(new Set(resolveSurfaceViewerTierAccess(role))).toEqual(
        new Set(members(roleDefaults[role]))
      );
      for (const mask of subsets) {
        const cap = members(mask);
        const valid = mask !== 0 && (mask & roleDefaults[role]) === mask;
        if (valid) expect(resolveSurfaceViewerTierAccess(role, cap)).toEqual(cap);
        else
          expect(() => resolveSurfaceViewerTierAccess(role, cap)).toThrow(SurfaceViewerScopeError);
      }
    }
    // Narrowing accepts a trusted resolved cap; it does not silently intersect
    // it with this role's defaults or grant defaults when the cap is empty.
    expect(
      narrowSurfaceViewerTier({ role: 'readonly', tierAccess: ['personal'] }, 'personal')
    ).toBe('personal');
  });

  it('fails closed when an untyped caller omits the required resolved cap', () => {
    for (const tierAccess of [undefined, null]) {
      const viewer = { role: 'localadmin', tierAccess } as unknown as Parameters<
        typeof narrowSurfaceViewerTier
      >[0];
      for (const tier of tiers) expect(observed(viewer, tier)).toBe(false);
    }
  });
});
