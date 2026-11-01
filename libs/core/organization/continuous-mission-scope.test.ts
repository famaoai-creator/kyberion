import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext, resetRoleAssumptionPolicyCache } from '../authority.js';
import { loadState } from '../mission/mission-state.js';
import {
  currentScopeEnvelope,
  mintScopeEnvelope,
  resetScopeEnvelopeState,
  withScopeEnvelope,
} from '../scope-envelope.js';
import type { MissionState } from '../mission/mission-types.js';
import { withContinuousMissionScope } from './continuous-mission-scope.js';

vi.mock('../mission/mission-state.js', () => ({ loadState: vi.fn() }));
vi.mock('../owner-scope.js', async (original) => ({
  ...(await original<typeof import('../owner-scope.js')>()),
  tryResolveOwnerScope: () => undefined,
}));
const missionId = 'MSN-CONTINUOUS-SCOPE-FIXTURE';
const canonical = (tier: 'public' | 'personal' | 'confidential') =>
  ({
    mission_id: missionId,
    tier,
    organization_id: 'fixture-org',
    ...(tier === 'confidential' ? { tenant_slug: 'acme' } : {}),
  }) as MissionState;
beforeEach(() => {
  for (const name of ['SYSTEM_ROLE', 'KYBERION_TENANT', 'MISSION_ID', 'KYBERION_ORGANIZATION_ID'])
    vi.stubEnv(name, '');
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('KYBERION_PERSONA', '');
  vi.stubEnv('KYBERION_DELEGATION_DEPTH', '0');
  vi.stubEnv('KYBERION_TIER', 'public');
  resetRoleAssumptionPolicyCache();
  resetScopeEnvelopeState();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetScopeEnvelopeState();
  resetRoleAssumptionPolicyCache();
});
describe('canonical continuous mission scope handoff', () => {
  it.each(['public', 'personal', 'confidential'] as const)(
    'binds %s from the verified owner and canonical mission without changing supervisor env',
    (tier) => {
      const state = canonical(tier);
      vi.mocked(loadState).mockReturnValue(state);
      const check = vi.fn();
      const input = {
        mission_id: missionId,
        scope: { tier, organization_id: state.organization_id!, tenant_slug: state.tenant_slug },
        assertCurrent: check,
      };
      const observed = withExecutionContext(
        'mission_controller',
        () => withContinuousMissionScope(input, () => currentScopeEnvelope()?.identity),
        undefined,
        state.tenant_slug,
        state.organization_id
      );
      expect(observed).toMatchObject({
        mission_id: missionId,
        tier,
        organization_id: 'fixture-org',
      });
      expect(observed?.tenant_slug).toBe(state.tenant_slug);
      expect(process.env.KYBERION_TIER).toBe('public');
      expect(currentScopeEnvelope()).toBeUndefined();
      expect(check).toHaveBeenCalledTimes(2);
    }
  );
  it('refuses canonical scope drift and a lost owner lease before entering the callback', () => {
    vi.mocked(loadState).mockReturnValue(canonical('confidential'));
    const run = vi.fn();
    withExecutionContext(
      'mission_controller',
      () => {
        expect(() =>
          withContinuousMissionScope(
            {
              mission_id: missionId,
              scope: { tier: 'public', organization_id: 'fixture-org' },
              assertCurrent: () => {},
            },
            run
          )
        ).toThrow('canonical mission');
        expect(() =>
          withContinuousMissionScope(
            {
              mission_id: missionId,
              scope: { tier: 'public', organization_id: 'fixture-org' },
              assertCurrent: () => {
                throw new Error('lease lost');
              },
            },
            run
          )
        ).toThrow('lease lost');
      },
      undefined,
      undefined,
      'fixture-org'
    );
    expect(run).not.toHaveBeenCalled();
  });
  it('cannot widen an existing public envelope to confidential', () => {
    const state = canonical('confidential');
    vi.mocked(loadState).mockReturnValue(state);
    const parent = mintScopeEnvelope({
      identity: {
        mission_id: missionId,
        tier: 'public',
        tenant_slug: 'acme',
        organization_id: 'fixture-org',
      },
      policy: { purpose: 'bounded parent', read_tiers: ['public'], write_tier: 'public' },
    });
    const run = vi.fn();
    expect(() =>
      withScopeEnvelope(parent, () =>
        withExecutionContext(
          'mission_controller',
          () =>
            withContinuousMissionScope(
              {
                mission_id: missionId,
                scope: {
                  tier: 'confidential',
                  tenant_slug: 'acme',
                  organization_id: 'fixture-org',
                },
                assertCurrent: () => {},
              },
              run
            ),
          undefined,
          'acme',
          'fixture-org'
        )
      )
    ).toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
