// Team Channel P1: speaker resolution against a hermetic member registry
// (same fixture-rootDir pattern as member-registry.test.ts).
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';
import { writeMemberProfile, type MemberProfile } from '../organization/member-registry.js';
import {
  linkMemberExternalIdentity,
  unlinkMemberExternalIdentity,
} from '../organization/member-identity-link.js';
import {
  evaluateChannelActorAccess,
  evaluateChannelApprovalAuthority,
  buildChannelDisclosureDirective,
  resolveChannelModePolicy,
} from './channel-mode-policy.js';
import {
  resolveChannelSpeaker,
  speakerCan,
  speakerDecisionId,
} from './channel-speaker-principal.js';

const SLACK = 'https://slack.com';

function member(
  id: string,
  slackId: string,
  memberships: MemberProfile['memberships'],
  status: MemberProfile['status'] = 'active'
): MemberProfile {
  return {
    member_id: id,
    display_name: id,
    status,
    memberships,
    access_registrations: [],
    external_identities: [{ issuer: SLACK, subject: slackId }],
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}

describe('channel-speaker-principal', () => {
  let fixtureRoot = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  const registry = () => ({ rootDir: fixtureRoot });

  beforeAll(() => {
    fixtureRoot = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `channel-speaker-${randomUUID()}`
    );
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    const options = { rootDir: fixtureRoot };
    writeMemberProfile(
      member('lead', 'U-LEAD', [{ tenant_slug: 'acme', role: 'approver' }]),
      options
    );
    writeMemberProfile(
      member('dev', 'U-DEV', [{ tenant_slug: 'acme', role: 'operator' }]),
      options
    );
    writeMemberProfile(
      member('watcher', 'U-VIEW', [{ tenant_slug: 'acme', role: 'viewer' }]),
      options
    );
    writeMemberProfile(
      member('other', 'U-OTHER', [{ tenant_slug: 'beta', role: 'owner' }]),
      options
    );
    writeMemberProfile(
      member('gone', 'U-GONE', [{ tenant_slug: 'acme', role: 'owner' }], 'suspended'),
      options
    );
  });

  afterAll(() => {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (fixtureRoot) safeRmSync(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function teamPolicy(approvers: string[] = []) {
    vi.stubEnv(
      'KYBERION_SURFACE_CHANNEL_MODES',
      JSON.stringify({ slack: { C1: { mode: 'team', tenant_slug: 'acme', approvers } } })
    );
    return resolveChannelModePolicy('slack', 'C1');
  }

  it('maps tenant roles to capabilities through the front-desk role table', () => {
    const policy = teamPolicy();
    const lead = resolveChannelSpeaker(policy, 'U-LEAD', registry());
    expect(lead).toMatchObject({ principalId: 'user:lead', role: 'approver', denied: false });
    expect(speakerCan(lead, 'decide')).toBe(true);
    expect(speakerCan(lead, 'request_work')).toBe(false);

    const dev = resolveChannelSpeaker(policy, 'U-DEV', registry());
    expect(speakerCan(dev, 'request_work')).toBe(true);
    expect(speakerCan(dev, 'decide')).toBe(false);

    const watcher = resolveChannelSpeaker(policy, 'U-VIEW', registry());
    expect(watcher.capabilities).toEqual(['ask']);
    expect(watcher.tierAccess).toEqual(['public', 'confidential']);
  });

  it('treats unregistered actors and members of other tenants as ask-only guests', () => {
    const policy = teamPolicy();
    for (const actor of ['U-NOBODY', 'U-OTHER']) {
      const speaker = resolveChannelSpeaker(policy, actor, registry());
      expect(speaker).toMatchObject({ denied: false, capabilities: ['ask'] });
      expect(speaker.principalId).toBeUndefined();
      expect(speakerDecisionId(speaker)).toBe(actor);
    }
  });

  it('denies an identity bound to a suspended member', () => {
    const speaker = resolveChannelSpeaker(teamPolicy(), 'U-GONE', registry());
    expect(speaker.denied).toBe(true);
    expect(speakerCan(speaker, 'ask')).toBe(false);
  });

  it('does not resolve speakers outside team mode', () => {
    const speaker = resolveChannelSpeaker(
      resolveChannelModePolicy('slack', 'C-DM'),
      'U-LEAD',
      registry()
    );
    expect(speaker.principalId).toBeUndefined();
  });

  it('admits tenant members without an allowlist and refuses suspended bindings', () => {
    const policy = teamPolicy();
    const options = { memberRegistry: registry() };
    expect(evaluateChannelActorAccess(policy, 'U-VIEW', options)).toMatchObject({
      allowed: true,
      reason: 'tenant_member',
    });
    expect(evaluateChannelActorAccess(policy, 'U-NOBODY', options)).toMatchObject({
      allowed: false,
      reason: 'allowlist_unconfigured',
    });
    vi.stubEnv('KYBERION_SURFACE_ALLOWLISTS', JSON.stringify({ slack: ['U-NOBODY', 'U-GONE'] }));
    expect(evaluateChannelActorAccess(policy, 'U-NOBODY', options).allowed).toBe(true);
    expect(evaluateChannelActorAccess(policy, 'U-GONE', options)).toMatchObject({
      allowed: false,
      reason: 'member_binding_denied',
    });
  });

  it('decides approvals by member role and records the member principal', () => {
    const policy = teamPolicy(['U-DEV', 'U-GUEST']);
    const options = { memberRegistry: registry() };
    expect(evaluateChannelApprovalAuthority(policy, 'U-LEAD', options)).toEqual({
      allowed: true,
      reason: 'member_approver',
      decidedBy: 'user:lead',
    });
    // A linked member's role wins over the transitional approvers list.
    expect(evaluateChannelApprovalAuthority(policy, 'U-DEV', options)).toMatchObject({
      allowed: false,
      decidedBy: 'user:dev',
    });
    // Actors not yet linked to a member still use the fallback list.
    expect(evaluateChannelApprovalAuthority(policy, 'U-GUEST', options)).toEqual({
      allowed: true,
      reason: 'channel_approver',
      decidedBy: 'U-GUEST',
    });
    expect(evaluateChannelApprovalAuthority(policy, 'U-GONE', options)).toMatchObject({
      allowed: false,
      reason: 'member_binding_denied',
    });
  });

  it('names the speaker in the disclosure directive', () => {
    const policy = teamPolicy();
    expect(
      buildChannelDisclosureDirective(policy, resolveChannelSpeaker(policy, 'U-DEV', registry()))
    ).toContain("user:dev (role 'operator'");
    expect(
      buildChannelDisclosureDirective(policy, resolveChannelSpeaker(policy, 'U-NOBODY', registry()))
    ).toContain('answer questions only');
  });

  it('links and unlinks identities, refusing one already bound to another member', () => {
    const options = registry();
    expect(
      linkMemberExternalIdentity('dev', { issuer: SLACK, subject: 'U-DEV2' }, options).status
    ).toBe('linked');
    expect(
      linkMemberExternalIdentity('dev', { issuer: SLACK, subject: 'U-DEV2' }, options).status
    ).toBe('already_linked');
    expect(() =>
      linkMemberExternalIdentity('watcher', { issuer: SLACK, subject: 'U-DEV2' }, options)
    ).toThrow(/already bound/);
    expect(
      unlinkMemberExternalIdentity('dev', { issuer: SLACK, subject: 'U-DEV2' }, options).status
    ).toBe('unlinked');
    expect(
      linkMemberExternalIdentity('nobody', { issuer: SLACK, subject: 'U-X' }, options).status
    ).toBe('member_not_found');
  });
});
