import { beforeAll, describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import * as path from 'node:path';
import {
  composeMissionTeamPlan,
  getMissionTeamAssignment,
  loadAgentProfileIndex,
  loadAuthorityRoleIndex,
  loadTeamRoleIndex,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core';

const rootDir = process.cwd();

function loadJson(filePath: string) {
  return JSON.parse(safeReadFile(path.join(rootDir, filePath), { encoding: 'utf8' }) as string);
}

function loadAgentProfileDirectoryPayloads() {
  const dir = path.join(rootDir, 'knowledge/product/orchestration/agent-profiles');
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => ({
      entry,
      payload: loadJson(`knowledge/product/orchestration/agent-profiles/${entry}`),
    }));
}

function loadTeamRoleDirectoryPayloads() {
  const dir = path.join(rootDir, 'knowledge/product/orchestration/team-roles');
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => ({
      entry,
      payload: loadJson(`knowledge/product/orchestration/team-roles/${entry}`),
    }));
}

describe('Mission team composition contract', () => {
  beforeAll(() => {
    // Provider selection consults discoverProviders(), which probes REAL
    // CLIs — green on a dev box with gemini/codex installed, red on CI.
    // Seed the discovery disk cache so the contract is hermetic.
    const cachePath = pathResolver.rootResolve('active/shared/runtime/provider-cache.json');
    if (!safeExistsSync(path.dirname(cachePath))) {
      safeMkdir(path.dirname(cachePath), { recursive: true });
    }
    const provider = (name: string) => ({
      provider: name,
      installed: true,
      version: '0.0.0-test',
      protocol: 'exec',
      models: [],
      healthy: true,
    });
    safeWriteFile(
      cachePath,
      JSON.stringify({
        ts: Date.now(),
        providers: [provider('gemini'), provider('claude'), provider('codex'), provider('agy')],
      })
    );
    // No refresh call here: refreshProviderDiscoveryCache() force-probes the
    // REAL environment and would overwrite this fixture. A fresh test process
    // has no in-memory cache, so the next discoverProviders() reads the disk
    // cache seeded above.
  });

  it('validates authority/team/agent indexes against schemas', () => {
    const ajv = new Ajv({ allErrors: true });
    const fixtures: Array<[string, string]> = [
      [
        'knowledge/product/governance/authority-role-index.json',
        'knowledge/product/schemas/authority-role-index.schema.json',
      ],
      [
        'knowledge/product/orchestration/team-role-index.json',
        'knowledge/product/schemas/team-role-index.schema.json',
      ],
      [
        'knowledge/product/orchestration/agent-profile-index.json',
        'knowledge/product/schemas/agent-profile-index.schema.json',
      ],
      [
        'knowledge/product/orchestration/mission-team-templates.json',
        'knowledge/product/schemas/mission-team-templates.schema.json',
      ],
    ];

    for (const [jsonPath, schemaPath] of fixtures) {
      const validate = ajv.compile(loadJson(schemaPath));
      const valid = validate(loadJson(jsonPath));
      expect(valid, ajv.errorsText(validate.errors)).toBe(true);
    }
  });

  it('requires selection hints on all agent and team role records', () => {
    const agentIndex = loadJson('knowledge/product/orchestration/agent-profile-index.json');
    const roleIndex = loadJson('knowledge/product/orchestration/team-role-index.json');

    for (const [agentId, record] of Object.entries(agentIndex.agents || {})) {
      expect(
        record.selection_hints?.preferred_provider,
        `missing provider hint for ${agentId}`
      ).toBeTruthy();
      expect(
        record.selection_hints?.preferred_modelId,
        `missing model hint for ${agentId}`
      ).toBeTruthy();
    }

    for (const [teamRole, record] of Object.entries(roleIndex.team_roles || {})) {
      expect(
        record.selection_hints?.preferred_agents?.length,
        `missing agent hints for ${teamRole}`
      ).toBeGreaterThan(0);
      expect(
        record.selection_hints?.preferred_models?.length,
        `missing model hints for ${teamRole}`
      ).toBeGreaterThan(0);
    }
  });

  it('keeps the canonical agent profile directory in sync with the snapshot', () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(
      loadJson('knowledge/product/schemas/agent-profile-index.schema.json')
    );
    const snapshot = loadJson('knowledge/product/orchestration/agent-profile-index.json');
    const snapshotAgents = snapshot.agents || {};
    const dirPayloads = loadAgentProfileDirectoryPayloads();

    expect(dirPayloads.length).toBeGreaterThan(0);

    const dirAgents: Record<string, unknown> = {};
    for (const { entry, payload } of dirPayloads) {
      const valid = validate(payload);
      expect(valid, ajv.errorsText(validate.errors)).toBe(true);

      const agentIds = Object.keys((payload as { agents?: Record<string, unknown> }).agents || {});
      expect(agentIds, `${entry} must contain exactly one agent profile`).toHaveLength(1);
      const agentId = agentIds[0];
      expect(entry.replace(/\.json$/i, '')).toBe(agentId);
      dirAgents[agentId] = (payload as { agents: Record<string, unknown> }).agents[agentId];
      expect(snapshotAgents[agentId], `snapshot missing agent ${agentId}`).toEqual(
        dirAgents[agentId]
      );
    }

    expect(Object.keys(dirAgents).sort()).toEqual(Object.keys(snapshotAgents).sort());
  });

  it('keeps the canonical team role directory in sync with the snapshot', () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(loadJson('knowledge/product/schemas/team-role.schema.json'));
    const snapshot = loadJson('knowledge/product/orchestration/team-role-index.json');
    const snapshotRoles = snapshot.team_roles || {};
    const dirPayloads = loadTeamRoleDirectoryPayloads();

    expect(dirPayloads.length).toBeGreaterThan(0);

    const dirRoles: Record<string, unknown> = {};
    for (const { entry, payload } of dirPayloads) {
      const valid = validate(payload);
      expect(valid, ajv.errorsText(validate.errors)).toBe(true);

      const roleId = (payload as { role?: string }).role;
      expect(roleId, `${entry} must declare role`).toBeTruthy();
      expect(entry.replace(/\.json$/i, '')).toBe(roleId);
      const { role, ...record } = payload as { role?: string; [key: string]: unknown };
      dirRoles[roleId!] = record;
      expect(snapshotRoles[roleId], `snapshot missing role ${roleId}`).toEqual(dirRoles[roleId]);
    }

    expect(Object.keys(dirRoles).sort()).toEqual(Object.keys(snapshotRoles).sort());
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
    expect(plan.team_governance?.lifecycle.max_parallel_members).toBeGreaterThan(0);
    expect(plan.team_governance?.composition.required_roles).toContain('owner');
    expect(plan.assignments.find((entry) => entry.team_role === 'owner')?.agent_id).toBe(
      'nerve-agent'
    );
    expect(plan.assignments.find((entry) => entry.team_role === 'implementer')?.agent_id).toBe(
      'reasoning-worker'
    );
    expect(plan.assignments.find((entry) => entry.team_role === 'implementer')?.provider).toMatch(
      /^(gemini|codex|agy)$/
    );
    expect(plan.assignments.find((entry) => entry.team_role === 'surface_liaison')?.required).toBe(
      false
    );

    for (const assignment of plan.assignments.filter((entry) => entry.status === 'assigned')) {
      expect(agents[assignment.agent_id!].team_roles).toContain(assignment.team_role);
      expect(teamRoles[assignment.team_role].compatible_authority_roles).toContain(
        assignment.authority_role!
      );
      expect(authorityRoles[assignment.authority_role!]).toBeDefined();
    }
  });

  it('validates the composed team plan against schema', () => {
    const ajv = new Ajv({ allErrors: true });
    ajv.addSchema(
      loadJson('knowledge/product/schemas/mission-classification.schema.json'),
      'mission-classification.schema.json'
    );
    ajv.addSchema(
      loadJson('knowledge/product/schemas/security-scope.schema.json'),
      'security-scope.schema.json'
    );
    const validate = ajv.compile(
      loadJson('knowledge/product/schemas/mission-team-plan.schema.json')
    );
    const plan = composeMissionTeamPlan({
      missionId: 'MSN-TEAM-PLAN',
      missionType: 'operations',
      tier: 'confidential',
      assignedPersona: 'Reliability Engineer',
    });

    const valid = validate(plan);
    expect(valid, ajv.errorsText(validate.errors)).toBe(true);
    expect(plan.team_governance?.composition.assigned_roles.length).toBeGreaterThan(0);
  });

  it('predefines a product development team shape', () => {
    const plan = composeMissionTeamPlan({
      missionId: 'MSN-PRODUCT-TEAM',
      missionType: 'product_development',
      tier: 'public',
      assignedPersona: 'Product Architect',
    });

    expect(plan.template).toBe('product_development');
    expect(
      plan.assignments.find((entry) => entry.team_role === 'product_strategist')?.agent_id
    ).toBe('sovereign-brain');
    expect(
      plan.assignments.find((entry) => entry.team_role === 'experience_designer')?.required
    ).toBe(false);
    expect(plan.assignments.find((entry) => entry.team_role === 'operator')?.provider).toMatch(
      /^(gemini|codex|agy)$/
    );
    expect(plan.assignments.find((entry) => entry.team_role === 'operator')?.modelId).toBeTruthy();
  });

  it('fills meeting operations roles for facilitation and tracking', () => {
    const plan = composeMissionTeamPlan({
      missionId: 'MSN-MEETING-TEAM',
      missionType: 'meeting_operations',
      tier: 'public',
      assignedPersona: 'Meeting Facilitator',
    });

    const facilitator = plan.assignments.find((entry) => entry.team_role === 'facilitator');
    const scribe = plan.assignments.find((entry) => entry.team_role === 'scribe');
    const tracker = plan.assignments.find((entry) => entry.team_role === 'tracker');

    expect(plan.team_governance?.composition.unfilled_required_roles).toEqual([]);
    expect(facilitator?.status).toBe('assigned');
    expect(scribe?.status).toBe('assigned');
    expect(tracker?.status).toBe('assigned');
    expect(facilitator?.agent_id).toBeTruthy();
    expect(scribe?.agent_id).toBeTruthy();
    expect(tracker?.agent_id).toBeTruthy();
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
