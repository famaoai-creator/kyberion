import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import * as path from 'node:path';
import {
  composeMissionTeamPlan,
  getMissionTeamAssignment,
  loadAgentProfileIndex,
  loadAuthorityRoleIndex,
  loadTeamRoleIndex,
  safeReadFile,
} from '@agent/core';

const rootDir = process.cwd();

function loadJson(filePath: string) {
  return JSON.parse(safeReadFile(path.join(rootDir, filePath), { encoding: 'utf8' }) as string);
}

describe('Mission team composition contract', () => {
  it('validates authority/team/agent indexes against schemas', () => {
    const ajv = new Ajv({ allErrors: true });
    const fixtures: Array<[string, string]> = [
      ['knowledge/public/governance/authority-role-index.json', 'knowledge/public/schemas/authority-role-index.schema.json'],
      ['knowledge/public/orchestration/team-role-index.json', 'knowledge/public/schemas/team-role-index.schema.json'],
      ['knowledge/public/orchestration/agent-profile-index.json', 'knowledge/public/schemas/agent-profile-index.schema.json'],
      ['knowledge/public/orchestration/mission-team-templates.json', 'knowledge/public/schemas/mission-team-templates.schema.json'],
    ];

    for (const [jsonPath, schemaPath] of fixtures) {
      const validate = ajv.compile(loadJson(schemaPath));
      const valid = validate(loadJson(jsonPath));
      expect(valid, ajv.errorsText(validate.errors)).toBe(true);
    }
  });

  it('requires selection hints on all agent and team role records', () => {
    const agentIndex = loadJson('knowledge/public/orchestration/agent-profile-index.json');
    const roleIndex = loadJson('knowledge/public/orchestration/team-role-index.json');

    for (const [agentId, record] of Object.entries(agentIndex.agents || {})) {
      expect(record.selection_hints?.preferred_provider, `missing provider hint for ${agentId}`).toBeTruthy();
      expect(record.selection_hints?.preferred_modelId, `missing model hint for ${agentId}`).toBeTruthy();
    }

    for (const [teamRole, record] of Object.entries(roleIndex.team_roles || {})) {
      expect(record.selection_hints?.preferred_agents?.length, `missing agent hints for ${teamRole}`).toBeGreaterThan(0);
      expect(record.selection_hints?.preferred_models?.length, `missing model hints for ${teamRole}`).toBeGreaterThan(0);
    }
  });

  it('composes a development mission team with required assignments', () => {
    const authorityRoles = loadAuthorityRoleIndex();
    const teamRoles = loadTeamRoleIndex();
    const agents = loadAgentProfileIndex();
    const plan = composeMissionTeamPlan({
      missionId: 'MSN-TEAM-COMPOSE',
      missionType: 'development',
      tier: 'public',
      assignedPersona: 'Ecosystem Architect',
    });

    expect(plan.template).toBe('development');
    expect(plan.assignments.find((entry) => entry.team_role === 'owner')?.agent_id).toBe('nerve-agent');
    expect(plan.assignments.find((entry) => entry.team_role === 'implementer')?.agent_id).toBe('implementation-architect');
    expect(plan.assignments.find((entry) => entry.team_role === 'implementer')?.provider).toBe('gemini');
    expect(plan.assignments.find((entry) => entry.team_role === 'surface_liaison')?.required).toBe(false);

    for (const assignment of plan.assignments.filter((entry) => entry.status === 'assigned')) {
      expect(agents[assignment.agent_id!].team_roles).toContain(assignment.team_role);
      expect(teamRoles[assignment.team_role].compatible_authority_roles).toContain(assignment.authority_role!);
      expect(authorityRoles[assignment.authority_role!]).toBeDefined();
    }
  });

  it('validates the composed team plan against schema', () => {
    const ajv = new Ajv({ allErrors: true });
    ajv.addSchema(
      loadJson('knowledge/public/schemas/mission-classification.schema.json'),
      'mission-classification.schema.json',
    );
    const validate = ajv.compile(loadJson('knowledge/public/schemas/mission-team-plan.schema.json'));
    const plan = composeMissionTeamPlan({
      missionId: 'MSN-TEAM-PLAN',
      missionType: 'operations',
      tier: 'confidential',
      assignedPersona: 'Reliability Engineer',
    });

    const valid = validate(plan);
    expect(valid, ajv.errorsText(validate.errors)).toBe(true);
  });

  it('predefines a product development team shape', () => {
    const plan = composeMissionTeamPlan({
      missionId: 'MSN-PRODUCT-TEAM',
      missionType: 'product_development',
      tier: 'public',
      assignedPersona: 'Product Architect',
    });

    expect(plan.template).toBe('product_development');
    expect(plan.assignments.find((entry) => entry.team_role === 'product_strategist')?.agent_id).toBe('sovereign-brain');
    expect(plan.assignments.find((entry) => entry.team_role === 'experience_designer')?.required).toBe(false);
    expect(plan.assignments.find((entry) => entry.team_role === 'operator')?.provider).toMatch(/^(gemini|codex)$/);
    expect(plan.assignments.find((entry) => entry.team_role === 'operator')?.modelId).toBeTruthy();
  });

  it('returns a specific team assignment by role', () => {
    const missionId = 'MSN-TEAM-STORAGE';
    const plan = composeMissionTeamPlan({
      missionId,
      missionType: 'development',
      tier: 'public',
      assignedPersona: 'Ecosystem Architect',
    });

    expect(getMissionTeamAssignment(plan, 'owner')?.agent_id).toBe('nerve-agent');
    expect(getMissionTeamAssignment(plan, 'unknown-role')).toBeNull();
  });
});
