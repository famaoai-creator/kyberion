import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DotCharter } from './dot-charter.js';
import { runAsDotCharter } from './dot-key-results.js';
import { resetRoleAssumptionPolicyCache } from '../authority.js';
import {
  currentScopeEnvelope,
  mintScopeEnvelope,
  resetScopeEnvelopeState,
  withScopeEnvelope,
} from '../scope-envelope.js';
const dot = (tier: 'public' | 'personal' | 'confidential') =>
  ({
    kind: 'dot-charter',
    dot_id: 'resident-scope-fixture',
    scope: {
      tier,
      owner_nhi: 'resident-owner',
      organization_id: 'fixture-org',
      ...(tier === 'confidential' ? { tenant_slug: 'acme' } : {}),
    },
    authority: { authority_role: 'organization_operator' },
  }) as DotCharter;
beforeEach(() => {
  vi.stubEnv('SYSTEM_ROLE', '');
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('KYBERION_TIER', 'public');
  vi.stubEnv('KYBERION_PERSONA', '');
  vi.stubEnv('KYBERION_TENANT', '');
  vi.stubEnv('KYBERION_ORGANIZATION_ID', '');
  vi.stubEnv('MISSION_ID', '');
  resetRoleAssumptionPolicyCache();
  resetScopeEnvelopeState();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetScopeEnvelopeState();
  resetRoleAssumptionPolicyCache();
});
describe('resident private dot composition', () => {
  it.each(['personal', 'confidential'] as const)(
    'refuses public execution with ambient %s identity and no envelope',
    async (tier) => {
      vi.stubEnv('KYBERION_TIER', tier);
      vi.stubEnv('KYBERION_NHI_ID', 'resident-owner');
      if (tier === 'confidential') vi.stubEnv('KYBERION_TENANT', 'acme');
      const execute = vi.fn(async () => {});
      expect(currentScopeEnvelope()).toBeUndefined();
      await expect(runAsDotCharter(dot('public'), execute)).rejects.toThrow('Public resident dot');
      expect(execute).not.toHaveBeenCalled();
    }
  );
  it.each(['personal', 'confidential'] as const)(
    'refuses to run a public dot with an inherited %s data policy',
    async (tier) => {
      const parent = mintScopeEnvelope({
        identity: {
          tier,
          session_id: 'private-resident-parent',
          ...(tier === 'confidential' ? { tenant_slug: 'acme' } : {}),
        },
        policy: { purpose: 'private task', read_tiers: ['public', tier], write_tier: tier },
        env: { ...process.env, KYBERION_TIER: tier },
      });
      const execute = vi.fn(async () => {});
      await expect(
        withScopeEnvelope(parent, () => runAsDotCharter(dot('public'), execute))
      ).rejects.toThrow('Public resident dot');
      expect(execute).not.toHaveBeenCalled();
    }
  );
  it.each(['personal', 'confidential'] as const)(
    'uses actual %s data scope before a mission exists and across async continuation',
    async (tier) => {
      await runAsDotCharter(dot(tier), async () => {
        await Promise.resolve();
        const envelope = currentScopeEnvelope()!;
        expect(envelope.identity).toMatchObject({
          tier,
          nhi_id: 'resident-owner',
          organization_id: 'fixture-org',
        });
        expect(envelope.identity.tenant_slug).toBe(tier === 'confidential' ? 'acme' : undefined);
        expect(envelope.identity.mission_id).toBeUndefined();
        expect(envelope.policy.read_tiers).toContain(tier);
        expect(envelope.policy.write_tier).toBe(tier);
        expect(process.env.KYBERION_TIER).toBe('public');
      });
      expect(currentScopeEnvelope()).toBeUndefined();
    }
  );
  it('refuses a private dot inside an explicit public capability ceiling', async () => {
    const parent = mintScopeEnvelope({
      identity: { tier: 'public', session_id: 'bounded-resident-fixture' },
      policy: { purpose: 'public task', read_tiers: ['public'], write_tier: 'public' },
    });
    const execute = vi.fn(async () => {});
    await expect(
      withScopeEnvelope(parent, () => runAsDotCharter(dot('personal'), execute))
    ).rejects.toThrow('active envelope');
    expect(execute).not.toHaveBeenCalled();
  });
});
