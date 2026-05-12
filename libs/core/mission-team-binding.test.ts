import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as pathResolver from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';
import {
  appendMissionExecutionLedgerEntry,
  buildMissionStaffingAssignments,
  buildMissionTeamBlueprint,
  initializeMissionTeamBindings,
} from './mission-team-binding.js';
import type { MissionTeamPlan } from './mission-team-plan-composer.js';

const MISSION_ID = 'MSN-BINDING-TEST-001';
const TEST_MISSION_DIR = pathResolver.sharedTmp(`mission-team-binding-tests/${MISSION_ID}`);

const SAMPLE_PLAN: MissionTeamPlan = {
  mission_id: MISSION_ID,
  mission_type: 'development',
  tier: 'public',
  template: 'development',
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

    expect(blueprint.roles.length).toBe(2);
    expect(blueprint.roles[0]?.team_role).toBe('owner');
    expect(blueprint.team_governance?.lifecycle.max_members).toBe(7);
    expect(staffing.assignments.length).toBe(1);
    expect(staffing.assignments[0]?.actor_id).toBe('nerve-agent');
    expect(staffing.assignments[0]?.status).toBe('active');
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
    const parsed = JSON.parse(lines[0] || '{}') as { mission_id?: string; actor_id?: string; team_role?: string };
    expect(parsed.mission_id).toBe(MISSION_ID);
    expect(parsed.actor_id).toBe('nerve-agent');
    expect(parsed.team_role).toBe('owner');
  });
});
