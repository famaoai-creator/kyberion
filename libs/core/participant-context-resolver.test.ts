import { describe, expect, it } from 'vitest';
import {
  listDeterministicParticipantTeamRoles,
  resolveParticipantContext,
} from './participant-context-resolver.js';
import { safeReadFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';

const securityScope = {
  tenant_id: 'tenant-a',
  project_id: 'project-x',
  mission_id: 'MSN-123',
  participant_id: 'implementation',
  read_tiers: ['public', 'confidential'] as const,
  write_tier: 'confidential' as const,
  purpose: 'implementation',
};

describe('resolveParticipantContext', () => {
  it('resolves a cold-start implementer without LLM selection', () => {
    const result = resolveParticipantContext({
      participant_id: 'implementation',
      team_role_id: 'implementer',
      security_scope: { ...securityScope, read_tiers: [...securityScope.read_tiers] },
    });

    expect(result.participant).toMatchObject({
      agent_profile_id: 'reasoning-worker',
      authority_role_id: 'software_developer',
      organization_role_id: 'software_developer',
      team_role_id: 'implementer',
      perspective_ids: ['focused_craftsman'],
      reasoning_route_id: 'default',
    });
    expect(result.selection_reason_codes).toContain('TEAM_ROLE_IMPLEMENTER_DEFAULT');
  });

  it('selects a high-confidence route for high-risk review', () => {
    const result = resolveParticipantContext({
      participant_id: 'implementation',
      team_role_id: 'reviewer',
      risk: 'high_stakes',
      security_scope: { ...securityScope, read_tiers: [...securityScope.read_tiers] },
    });
    expect(result.participant.reasoning_route_id).toBe('high-confidence');
    expect(result.selection_reason_codes).toContain('RISK_HIGH_ROUTE');
  });

  it('fails closed for an unmapped team role', () => {
    expect(() =>
      resolveParticipantContext({
        participant_id: 'implementation',
        team_role_id: 'invented-role',
        security_scope: { ...securityScope, read_tiers: [...securityScope.read_tiers] },
      })
    ).toThrow('[PARTICIPANT_ROLE_UNRESOLVED]');
  });

  it('covers every canonical team role without an LLM fallback', () => {
    const catalog = JSON.parse(
      safeReadFile(pathResolver.knowledge('product/orchestration/team-role-index.json'), {
        encoding: 'utf8',
      }) as string
    ) as { team_roles: Record<string, unknown> };
    expect(listDeterministicParticipantTeamRoles()).toEqual(Object.keys(catalog.team_roles).sort());
  });
});
