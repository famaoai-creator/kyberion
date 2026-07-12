import { describe, expect, it } from 'vitest';
import {
  renderReasoningParticipantContext,
  resolveReasoningParticipant,
  type ReasoningParticipant,
} from './reasoning-participant.js';

const participant: ReasoningParticipant = {
  participant_id: 'security-review',
  organization_role_id: 'cyber_security',
  team_role_id: 'reviewer',
  perspective_ids: ['security_attacker', 'rigorous_validator'],
  agent_profile_id: 'reasoning-worker',
  authority_role_id: 'ecosystem_architect',
  reasoning_route_id: 'high-confidence',
  security_scope: {
    tenant_id: 'tenant-a',
    project_id: 'project-x',
    mission_id: 'MSN-123',
    participant_id: 'security-review',
    read_tiers: ['public', 'confidential'],
    write_tier: 'confidential',
    purpose: 'security-review',
    external_egress: 'deny',
  },
};

describe('resolveReasoningParticipant', () => {
  it('compiles only scope-compatible fragments for a local backend', () => {
    const resolved = resolveReasoningParticipant({
      participant,
      backend_name: 'local',
      candidate_fragments: [
        {
          fragment_id: 'MATCH',
          source_ref: 'knowledge/confidential/tenant-a/project-x/review.md',
          source_tier: 'confidential',
          tenant_id: 'tenant-a',
          project_id: 'project-x',
          mission_id: 'MSN-123',
          purpose_tags: ['security-review'],
          content: 'allowed',
        },
        {
          fragment_id: 'OTHER-TENANT',
          source_ref: 'knowledge/confidential/tenant-b/project-x/review.md',
          source_tier: 'confidential',
          tenant_id: 'tenant-b',
          project_id: 'project-x',
          mission_id: 'MSN-123',
          purpose_tags: ['security-review'],
          content: 'denied',
        },
      ],
    });

    expect(resolved.context_pack.fragments.map((entry) => entry.fragment_id)).toEqual(['MATCH']);
    expect(resolved.context_pack.rejected[0]?.code).toBe('TENANT_SCOPE_MISMATCH');
    expect(renderReasoningParticipantContext(resolved)).toMatchObject({
      participant_id: 'security-review',
      context_fragments: [{ fragment_id: 'MATCH', content: 'allowed' }],
    });
  });

  it('blocks external backend dispatch when egress is denied', () => {
    expect(() => resolveReasoningParticipant({ participant, backend_name: 'codex-cli' })).toThrow(
      '[CONTEXT_EGRESS_DENIED]'
    );
  });

  it('rejects a participant whose scope belongs to another participant', () => {
    expect(() =>
      resolveReasoningParticipant({
        participant: {
          ...participant,
          security_scope: { ...participant.security_scope, participant_id: 'other' },
        },
        backend_name: 'local',
      })
    ).toThrow('[REASONING_PARTICIPANT_INVALID]');
  });
});
