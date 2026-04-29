import { describe, expect, it } from 'vitest';
import { selectAgentForTeamRole } from './team-role-assignment-selection.js';

describe('team-role assignment selection', () => {
  it('prefers a capability-matching preferred agent', () => {
    const assignment = selectAgentForTeamRole(
      'owner',
      {
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
      {
        mission_controller: {
          description: 'Mission controller',
          write_scopes: ['mission_state.write'],
          scope_classes: ['mission_state'],
          allowed_actuators: [],
          tier_access: ['public'],
        },
      },
      {
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
    );

    expect(assignment.status).toBe('assigned');
    expect(assignment.agent_id).toBe('nerve-agent');
    expect(assignment.provider).toBe('gemini');
    expect(assignment.modelId).toBe('auto-gemini-3');
  });

  it('returns unfilled when no compatible agent exists', () => {
    const assignment = selectAgentForTeamRole(
      'owner',
      {
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
      {
        mission_controller: {
          description: 'Mission controller',
          write_scopes: ['mission_state.write'],
          scope_classes: ['mission_state'],
          allowed_actuators: [],
          tier_access: ['public'],
        },
      },
      {
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
    );

    expect(assignment.status).toBe('unfilled');
    expect(assignment.agent_id).toBeNull();
  });
});
