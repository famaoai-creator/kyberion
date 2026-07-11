import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as pathResolver from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  appendMissionExecutionLedgerEntry,
  buildMissionStaffingAssignments,
  buildMissionTeamBlueprint,
  initializeMissionTeamBindings,
  loadMissionStaffingAssignments,
} from './mission-team-binding.js';
import type {
  MissionTeamOrganizationProfileSummary,
  MissionTeamPlan,
} from './mission-team-plan-composer.js';

const MISSION_ID = 'MSN-BINDING-TEST-001';
const TEST_MISSION_DIR = pathResolver.sharedTmp(`mission-team-binding-tests/${MISSION_ID}`);
const SAMPLE_ORG_PROFILE: MissionTeamOrganizationProfileSummary = {
  organization_id: 'demo-org',
  name: 'Demo Org',
  default_team_template: 'development',
  default_agent_profile: 'planner-agent',
};

const SAMPLE_PLAN: MissionTeamPlan = {
  mission_id: MISSION_ID,
  mission_type: 'development',
  tier: 'public',
  template: 'development',
  organization_profile: SAMPLE_ORG_PROFILE,
  generated_at: '2026-04-19T00:00:00.000Z',
  team_governance: {
    lifecycle: {
      max_parallel_members: 5,
      max_members: 7,
      max_messages_per_run: 60,
      max_wall_clock_minutes: 180,
      max_member_turns: 10,
      shutdown_policy: 'graceful_handoff',
      resume_policy: 'checkpoint_resume',
      cooldown_minutes: 10,
    },
    composition: {
      required_roles: ['owner', 'planner'],
      optional_roles: ['tester'],
      assigned_roles: ['owner'],
      unfilled_required_roles: ['planner'],
    },
  },
  assignments: [
    {
      team_role: 'owner',
      required: true,
      status: 'assigned',
      agent_id: 'nerve-agent',
      authority_role: 'mission_controller',
      delegation_contract: {
        ownership_scope: 'Own mission integration.',
        allowed_delegate_team_roles: ['planner'],
        escalation_parent_team_role: null,
        required_scope_classes: ['mission_state'],
        resolved_scope_classes: ['mission_state'],
        allowed_write_scopes: ['active/missions/'],
      },
      provider: 'gemini',
      modelId: 'auto-gemini-3',
      required_capabilities: ['coordination'],
      notes: 'test',
    },
    {
      team_role: 'planner',
      required: true,
      status: 'unfilled',
      agent_id: null,
      authority_role: null,
      delegation_contract: null,
      provider: null,
      modelId: null,
      required_capabilities: ['planning'],
      notes: 'test',
    },
  ],
};

describe('mission-team-binding', () => {
  beforeEach(() => {
    safeRmSync(TEST_MISSION_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    safeRmSync(TEST_MISSION_DIR, { recursive: true, force: true });
  });

  it('builds blueprint and staffing views from team plan', () => {
    const blueprint = buildMissionTeamBlueprint(SAMPLE_PLAN);
    const staffing = buildMissionStaffingAssignments(SAMPLE_PLAN);

    expect(blueprint.organization_profile?.organization_id).toBe('demo-org');
    expect(blueprint.roles.length).toBe(2);
    expect(blueprint.roles[0]?.team_role).toBe('owner');
    expect(blueprint.team_governance?.lifecycle.max_members).toBe(7);
    expect(staffing.organization_profile?.default_agent_profile).toBe('planner-agent');
    expect(staffing.assignments.length).toBe(1);
    expect(staffing.assignments[0]?.actor_id).toBe('nerve-agent');
    expect(staffing.assignments[0]?.status).toBe('active');
    expect(staffing.assignments[0]?.resource.resource_type).toBe('agent');
    expect(staffing.assignments[0]?.resource.resource_id).toBe('nerve-agent');
  });

  it('binds human and service resources alongside agents', () => {
    const plan: MissionTeamPlan = {
      ...SAMPLE_PLAN,
      assignments: [
        {
          ...SAMPLE_PLAN.assignments[0],
          agent_id: null,
          actor_type: 'human',
          resource: {
            resource_id: 'human:founder',
            resource_type: 'human',
            display_name: 'Founder',
            authority_roles: ['mission_controller'],
            capabilities: ['approval'],
            availability: { status: 'available' },
            cost_profile: { currency: 'JPY', hourly_rate: 0 },
            status: 'active',
            accountable_human_id: null,
          },
        },
        {
          ...SAMPLE_PLAN.assignments[0],
          team_role: 'service_runtime',
          agent_id: null,
          actor_type: 'service',
          resource: {
            resource_id: 'service:stripe',
            resource_type: 'service',
            display_name: 'Stripe',
            authority_roles: ['service_operator'],
            capabilities: ['payments'],
            availability: { status: 'available' },
            cost_profile: { currency: 'JPY', per_call: 10 },
            status: 'active',
            accountable_human_id: 'human:founder',
            runtime_identity: 'stripe-prod',
          },
        },
      ],
    };

    const staffing = buildMissionStaffingAssignments(plan);
    expect(staffing.assignments.map((entry) => entry.actor_type)).toEqual(['human', 'service']);
    expect(staffing.assignments[1]?.accountable_human_id).toBeUndefined();
    expect(staffing.assignments[1]?.resource.accountable_human_id).toBe('human:founder');
  });

  it('rejects a new agent or service resource without human accountability', () => {
    const plan: MissionTeamPlan = {
      ...SAMPLE_PLAN,
      assignments: [
        {
          ...SAMPLE_PLAN.assignments[0],
          resource: {
            resource_id: 'agent:unowned',
            resource_type: 'agent',
            display_name: 'Unowned Agent',
            authority_roles: [],
            capabilities: [],
            availability: {},
            cost_profile: {},
            status: 'active',
            accountable_human_id: null,
          },
        },
      ],
    };

    expect(() => buildMissionStaffingAssignments(plan)).toThrow(/accountable_human_id/);
  });

  it('initializes binding artifacts and appends execution ledger entries', () => {
    const paths = initializeMissionTeamBindings(TEST_MISSION_DIR, SAMPLE_PLAN);
    expect(safeExistsSync(paths.teamBlueprintPath)).toBe(true);
    expect(safeExistsSync(paths.staffingAssignmentsPath)).toBe(true);
    expect(safeExistsSync(paths.executionLedgerPath)).toBe(true);

    appendMissionExecutionLedgerEntry({
      mission_id: MISSION_ID,
      mission_path_hint: TEST_MISSION_DIR,
      event_type: 'task_issued',
      task_id: 'task-1',
      team_role: 'owner',
      actor_id: 'nerve-agent',
      actor_type: 'agent',
      decision: 'task issued',
      evidence: ['PLAN.md'],
    });

    const lines = (safeReadFile(paths.executionLedgerPath, { encoding: 'utf8' }) as string)
      .split('\n')
      .filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0] || '{}') as {
      mission_id?: string;
      actor_id?: string;
      team_role?: string;
    };
    expect(parsed.mission_id).toBe(MISSION_ID);
    expect(parsed.actor_id).toBe('nerve-agent');
    expect(parsed.team_role).toBe('owner');
  });

  it('normalizes legacy staffing artifacts when loading them', () => {
    const paths = initializeMissionTeamBindings(TEST_MISSION_DIR, SAMPLE_PLAN);
    const legacy = {
      version: '1.0.0',
      mission_id: MISSION_ID,
      generated_at: '2026-04-19T00:00:00.000Z',
      assignments: [
        {
          assignment_id: 'legacy-owner',
          mission_id: MISSION_ID,
          team_role: 'owner',
          actor_id: 'legacy-agent',
          actor_type: 'agent',
          authority_role: null,
          provider: 'stub',
          model_id: 'legacy-model',
          assigned_at: '2026-04-19T00:00:00.000Z',
          released_at: null,
          status: 'active',
          source: 'team_composition',
        },
      ],
    };
    safeWriteFile(paths.staffingAssignmentsPath, JSON.stringify(legacy));

    const loaded = loadMissionStaffingAssignments(MISSION_ID, TEST_MISSION_DIR);
    expect(loaded?.assignments[0]?.resource.resource_id).toBe('legacy-agent');
    expect(loaded?.assignments[0]?.resource.resource_type).toBe('agent');
    expect(loaded?.assignments[0]?.resource.model_id).toBe('legacy-model');
  });
});
