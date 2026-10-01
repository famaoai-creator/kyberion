import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildChannelDisclosureDirective,
  channelTurnScope,
  decideChannelEngagement,
  evaluateChannelActorAccess,
  evaluateChannelApprovalAuthority,
  resolveChannelModePolicy,
} from './channel-mode-policy.js';

const TEAM_CONFIG = {
  slack: {
    C0TEAM: { mode: 'team', tenant_slug: 'acme', approvers: ['U0LEAD'] },
    C0PUB: { mode: 'team', tenant_slug: 'acme', max_tier: 'public' },
    C0HIGH: { mode: 'team', tenant_slug: 'acme', max_tier: 'personal' },
  },
};

function stubModes(value: unknown): void {
  vi.stubEnv(
    'KYBERION_SURFACE_CHANNEL_MODES',
    typeof value === 'string' ? value : JSON.stringify(value)
  );
}

describe('channel-mode-policy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('resolveChannelModePolicy', () => {
    it('keeps unconfigured and unlisted channels in owner_direct mode', () => {
      expect(resolveChannelModePolicy('slack', 'C0DM').mode).toBe('owner_direct');
      stubModes(TEAM_CONFIG);
      const policy = resolveChannelModePolicy('slack', 'C0OTHER');
      expect(policy).toMatchObject({
        mode: 'owner_direct',
        source: 'default',
        maxTier: 'personal',
      });
      expect(resolveChannelModePolicy('discord', 'C0TEAM').mode).toBe('owner_direct');
    });

    it('resolves a team channel with tenant, default confidential tier and approvers', () => {
      stubModes(TEAM_CONFIG);
      expect(resolveChannelModePolicy('Slack', 'C0TEAM')).toMatchObject({
        mode: 'team',
        tenantSlug: 'acme',
        maxTier: 'confidential',
        approvers: ['U0LEAD'],
        source: 'configured',
      });
      expect(resolveChannelModePolicy('slack', 'C0PUB').maxTier).toBe('public');
    });

    it('clamps a configured tier to the team ceiling', () => {
      stubModes(TEAM_CONFIG);
      expect(resolveChannelModePolicy('slack', 'C0HIGH').maxTier).toBe('confidential');
    });

    it.each([
      ['invalid JSON', '{bad'],
      ['missing tenant', { slack: { C1: { mode: 'team' } } }],
      ['reserved tenant', { slack: { C1: { mode: 'team', tenant_slug: 'shared' } } }],
      ['customer mode', { slack: { C1: { mode: 'customer', tenant_slug: 'acme' } } }],
      ['unknown mode', { slack: { C1: { mode: 'broadcast' } } }],
      ['bad tier', { slack: { C1: { mode: 'team', tenant_slug: 'acme', max_tier: 'secret' } } }],
      ['bad approvers', { slack: { C1: { mode: 'team', tenant_slug: 'acme', approvers: [1] } } }],
    ])('fails closed on %s', (_label, config) => {
      stubModes(config);
      const policy = resolveChannelModePolicy('slack', 'C1');
      expect(policy.source).toBe('invalid');
      expect(policy.mode).toBe('team');
      expect(evaluateChannelActorAccess(policy, 'U1').allowed).toBe(false);
      expect(evaluateChannelApprovalAuthority(policy, 'U1').allowed).toBe(false);
    });

    it('drops wildcard approvers', () => {
      stubModes({ slack: { C1: { mode: 'team', tenant_slug: 'acme', approvers: ['*', 'U1'] } } });
      expect(resolveChannelModePolicy('slack', 'C1').approvers).toEqual(['U1']);
    });
  });

  describe('evaluateChannelActorAccess', () => {
    it('denies team speakers when no allowlist is configured, unlike owner_direct', () => {
      stubModes(TEAM_CONFIG);
      expect(
        evaluateChannelActorAccess(resolveChannelModePolicy('slack', 'C0TEAM'), 'U1')
      ).toMatchObject({
        allowed: false,
        reason: 'allowlist_unconfigured',
      });
      expect(
        evaluateChannelActorAccess(resolveChannelModePolicy('slack', 'C0DM'), 'U1').allowed
      ).toBe(true);
    });

    it('allows allowlisted team speakers', () => {
      stubModes(TEAM_CONFIG);
      vi.stubEnv('KYBERION_SURFACE_ALLOWLISTS', JSON.stringify({ slack: ['U1'] }));
      const policy = resolveChannelModePolicy('slack', 'C0TEAM');
      expect(evaluateChannelActorAccess(policy, 'U1').allowed).toBe(true);
      expect(evaluateChannelActorAccess(policy, 'U2').allowed).toBe(false);
    });
  });

  describe('decideChannelEngagement', () => {
    it('answers every owner_direct message and strips the mention', async () => {
      const decision = await decideChannelEngagement(resolveChannelModePolicy('slack', 'C0DM'), {
        text: '<@UBOT> hello',
        agentUserId: 'UBOT',
        isThreadReply: false,
      });
      expect(decision).toEqual({
        respond: true,
        reason: 'mode_does_not_require_mention',
        text: 'hello',
      });
    });

    it('answers team messages only when mentioned or in a participating thread', async () => {
      stubModes(TEAM_CONFIG);
      const policy = resolveChannelModePolicy('slack', 'C0TEAM');
      await expect(
        decideChannelEngagement(policy, {
          text: 'status of the release <@UBOT|kyberion>?',
          agentUserId: 'UBOT',
          isThreadReply: false,
        })
      ).resolves.toEqual({ respond: true, reason: 'mentioned', text: 'status of the release ?' });

      await expect(
        decideChannelEngagement(policy, {
          text: 'lunch?',
          agentUserId: 'UBOT',
          isThreadReply: false,
        })
      ).resolves.toMatchObject({ respond: false, reason: 'not_addressed' });

      await expect(
        decideChannelEngagement(policy, {
          text: '<@UOTHER> can you check',
          agentUserId: 'UBOT',
          isThreadReply: true,
          agentParticipatesInThread: () => false,
        })
      ).resolves.toMatchObject({ respond: false });

      const participates = vi.fn(async () => true);
      await expect(
        decideChannelEngagement(policy, {
          text: 'and the second one?',
          agentUserId: 'UBOT',
          isThreadReply: true,
          agentParticipatesInThread: participates,
        })
      ).resolves.toMatchObject({ respond: true, reason: 'participating_thread' });
      expect(participates).toHaveBeenCalledTimes(1);
    });

    it('does not respond in team mode when the agent id is unknown', async () => {
      stubModes(TEAM_CONFIG);
      await expect(
        decideChannelEngagement(resolveChannelModePolicy('slack', 'C0TEAM'), {
          text: '<@UBOT> hi',
          isThreadReply: false,
        })
      ).resolves.toMatchObject({ respond: false });
    });
  });

  describe('evaluateChannelApprovalAuthority', () => {
    it('restricts team approvals to channel approvers', () => {
      stubModes(TEAM_CONFIG);
      const team = resolveChannelModePolicy('slack', 'C0TEAM');
      expect(evaluateChannelApprovalAuthority(team, 'U0LEAD').allowed).toBe(true);
      expect(evaluateChannelApprovalAuthority(team, 'U1')).toEqual({
        allowed: false,
        reason: 'not_channel_approver',
      });
      expect(
        evaluateChannelApprovalAuthority(resolveChannelModePolicy('slack', 'C0PUB'), 'U0LEAD')
          .allowed
      ).toBe(false);
      expect(
        evaluateChannelApprovalAuthority(resolveChannelModePolicy('slack', 'C0DM'), 'U1').allowed
      ).toBe(true);
    });
  });

  describe('turn scope and disclosure', () => {
    it('scopes team turns to the tenant at the capped tier only', () => {
      stubModes(TEAM_CONFIG);
      const team = resolveChannelModePolicy('slack', 'C0TEAM');
      expect(channelTurnScope(team)).toEqual({ tier: 'confidential', tenant_slug: 'acme' });
      expect(buildChannelDisclosureDirective(team)).toContain("tenant 'acme'");
      const owner = resolveChannelModePolicy('slack', 'C0DM');
      expect(channelTurnScope(owner)).toBeUndefined();
      expect(buildChannelDisclosureDirective(owner)).toBeUndefined();
    });
  });
});
