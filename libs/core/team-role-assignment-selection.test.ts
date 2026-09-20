import { describe, expect, it } from 'vitest';
import { selectAgentForTeamRole } from './team-role-assignment-selection.js';

describe('team-role assignment selection', () => {
  it('prefers a capability-matching preferred agent', () => {
    const assignment = selectAgentForTeamRole({
      teamRole: 'owner',
      teamRoleRecord: {
        description: 'Owner role',
        required_capabilities: ['reasoning', 'coordination'],
        compatible_authority_roles: ['mission_controller'],
        allowed_delegate_team_roles: [],
        escalation_parent_team_role: null,
        required_scope_classes: ['mission_state'],
        ownership_scope: 'Owns the mission.',
        selection_hints: {
          preferred_agents: ['nerve-agent'],
          preferred_models: ['auto-gemini-3'],
        },
        autonomy_level: 'high',
      },
      authorityRoles: {
        mission_controller: {
          description: 'Mission controller',
          write_scopes: ['mission_state.write'],
          scope_classes: ['mission_state'],
          allowed_actuators: [],
          tier_access: ['public'],
        },
      },
      agents: {
        'nerve-agent': {
          authority_roles: ['mission_controller'],
          team_roles: ['owner'],
          capabilities: ['reasoning', 'coordination', 'analysis'],
          selection_hints: {
            preferred_provider: 'gemini',
            preferred_modelId: 'auto-gemini-3',
          },
          provider_strategy: 'strict',
        },
      },
    });

    expect(assignment.status).toBe('assigned');
    expect(assignment.agent_id).toBe('nerve-agent');
    expect(assignment.provider).toBe('gemini');
    expect(assignment.modelId).toBe('auto-gemini-3');
    // NI-01: assigned agents carry their canonical durable-identity name
    // (org resolved from the active organization profile when not passed).
    expect(assignment.runtime_identity).toMatch(
      /^kyberion:\/\/agent\/[a-z][a-z0-9-]*\/nerve-agent$/
    );
  });

  it('derives runtime_identity with an explicit organization id (NI-01)', () => {
    const assignment = selectAgentForTeamRole({
      teamRole: 'owner',
      teamRoleRecord: {
        description: 'Owner role',
        required_capabilities: ['reasoning'],
        compatible_authority_roles: ['mission_controller'],
        allowed_delegate_team_roles: [],
        escalation_parent_team_role: null,
        required_scope_classes: ['mission_state'],
        ownership_scope: 'Owns the mission.',
        autonomy_level: 'high',
      },
      authorityRoles: {
        mission_controller: {
          description: 'Mission controller',
          write_scopes: ['mission_state.write'],
          scope_classes: ['mission_state'],
          allowed_actuators: [],
          tier_access: ['public'],
        },
      },
      agents: {
        'nerve-agent': {
          authority_roles: ['mission_controller'],
          team_roles: ['owner'],
          capabilities: ['reasoning'],
          selection_hints: {
            preferred_provider: 'gemini',
            preferred_modelId: 'auto-gemini-3',
          },
          provider_strategy: 'strict',
        },
      },
      organizationId: 'demo-org',
    });

    expect(assignment.status).toBe('assigned');
    expect(assignment.runtime_identity).toBe('kyberion://agent/demo-org/nerve-agent');
  });

  it('returns unfilled when no compatible agent exists', () => {
    const assignment = selectAgentForTeamRole({
      teamRole: 'owner',
      teamRoleRecord: {
        description: 'Owner role',
        required_capabilities: ['reasoning'],
        compatible_authority_roles: ['mission_controller'],
        allowed_delegate_team_roles: [],
        escalation_parent_team_role: null,
        required_scope_classes: ['mission_state'],
        ownership_scope: 'Owns the mission.',
        selection_hints: {
          preferred_agents: ['nerve-agent'],
          preferred_models: ['auto-gemini-3'],
        },
        autonomy_level: 'high',
      },
      authorityRoles: {
        mission_controller: {
          description: 'Mission controller',
          write_scopes: ['mission_state.write'],
          scope_classes: ['mission_state'],
          allowed_actuators: [],
          tier_access: ['public'],
        },
      },
      agents: {
        'other-agent': {
          authority_roles: ['mission_controller'],
          team_roles: ['reviewer'],
          capabilities: ['analysis'],
          selection_hints: {
            preferred_provider: 'gemini',
            preferred_modelId: 'gemini-2.5-flash',
          },
          provider_strategy: 'strict',
        },
      },
    });

    expect(assignment.status).toBe('unfilled');
    expect(assignment.agent_id).toBeNull();
    expect(assignment.runtime_identity).toBeUndefined();
  });

  it('uses the governed provider default when an adaptive agent has no provider hint', () => {
    const assignment = selectAgentForTeamRole({
      teamRole: 'relationship_curator',
      teamRoleRecord: {
        description: 'Relationship curator role',
        required_capabilities: ['reasoning', 'curation'],
        compatible_authority_roles: ['knowledge_steward'],
        allowed_delegate_team_roles: [],
        escalation_parent_team_role: 'facilitator',
        required_scope_classes: ['knowledge_core'],
        ownership_scope: 'Maintains relationship knowledge.',
        autonomy_level: 'low',
      },
      authorityRoles: {
        knowledge_steward: {
          description: 'Knowledge steward',
          write_scopes: ['knowledge/'],
          scope_classes: ['knowledge_core'],
          allowed_actuators: [],
          tier_access: ['confidential'],
        },
      },
      agents: {
        'relationship-curator': {
          authority_roles: ['knowledge_steward'],
          team_roles: ['relationship_curator'],
          capabilities: ['reasoning', 'curation'],
          provider_strategy: 'adaptive',
        },
      },
    });

    expect(assignment.status).toBe('assigned');
    expect(assignment.agent_id).toBe('relationship-curator');
    expect(assignment.provider).toBeTruthy();
    expect(assignment.modelId).toBeTruthy();
  });
});
