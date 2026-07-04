import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearWorkCoordinationStore,
  setWorkCoordinationNamespace,
  listWorkItems,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import type { MissionState } from './mission-types.js';
import { dispatchMissionTickets } from './mission-ticket-dispatch.js';

const missionId = 'MSN-TICKET-DISPATCH-001';
const projectId = 'PRJ-TICKET-DISPATCH-001';
const missionPath = pathResolver.missionDir(missionId, 'public');

function makeMissionState(): MissionState {
  return {
    mission_id: missionId,
    mission_type: 'operations',
    tier: 'public',
    status: 'active',
    execution_mode: 'local',
    relationships: {
      project: {
        project_id: projectId,
        project_path: `active/projects/public/shared/${projectId}/project-os`,
        relationship_type: 'supports',
        affected_artifacts: ['knowledge/product/evolution/test.md'],
        gate_impact: 'informational',
        traceability_refs: [],
        note: 'Dispatch tickets for verification',
      },
      track: {
        track_id: 'TRK-TICKET-DISPATCH-001',
        track_name: 'Ticket Dispatch Track',
        track_type: 'operations',
        lifecycle_model: 'default-sdlc',
        relationship_type: 'belongs_to',
        traceability_refs: [],
        note: 'Test track',
      },
    },
    priority: 1,
    assigned_persona: 'worker',
    confidence_score: 1,
    git: {
      branch: 'mission/ticket-dispatch',
      start_commit: 'abc123',
      latest_commit: 'abc123',
      checkpoints: [],
    },
    history: [],
  };
}

beforeEach(() => {
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_PERSONA = 'worker';
  setWorkCoordinationNamespace('mission-ticket-dispatch-test');
  clearWorkCoordinationStore();
  if (!safeExistsSync(missionPath)) safeMkdir(missionPath, { recursive: true });
  safeWriteFile(`${missionPath}/mission-state.json`, JSON.stringify(makeMissionState(), null, 2));
});

afterEach(() => {
  clearWorkCoordinationStore();
  safeRmSync(missionPath, { recursive: true, force: true });
  setWorkCoordinationNamespace(null);
});

describe('mission ticket dispatch', () => {
  it('registers NEXT_TASKS as local work items and exports ticket payloads', async () => {
    const state = makeMissionState();
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-1',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Implement ticket dispatch flow',
            deliverable: 'scripts/refactor/mission-ticket-dispatch.ts',
            target_path: 'scripts/refactor/mission-ticket-dispatch.ts',
            risk: 'low',
            estimated_scope: 'S',
          },
        ],
        null,
        2
      )
    );

    const manifest = await dispatchMissionTickets(state, {
      targets: ['workitem', 'github', 'jira'],
    });

    expect(manifest.mission_id).toBe(missionId);
    expect(manifest.ticket_count).toBe(1);
    expect(manifest.records[0].work_item_id).toBeDefined();
    expect(manifest.records[0].ticket_files.length).toBe(2);

    const items = listWorkItems({ projectId });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: `${missionId}: Implement ticket dispatch flow`,
      status: 'ready',
      project_id: projectId,
      source: 'local',
    });
    expect(items[0].description).toContain('Assignee role: implementer');
    expect(items[0].description).toContain('Assignee agent: implementation-architect');
    expect(items[0].metadata).toMatchObject({
      risk: 'low',
      estimated_scope: 'S',
      task_model_hint: expect.objectContaining({
        model_id: 'openai:gpt-5.4-mini',
        tier: 'small',
        effort: 'low',
      }),
    });

    const githubPayload = JSON.parse(
      safeReadFile(`${missionPath}/coordination/tickets/github/task-1.json`, {
        encoding: 'utf8',
      }) as string
    );
    const jiraPayload = JSON.parse(
      safeReadFile(`${missionPath}/coordination/tickets/jira/task-1.json`, {
        encoding: 'utf8',
      }) as string
    );
    const nextTasks = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );

    expect(githubPayload.title).toContain('Implement ticket dispatch flow');
    expect(githubPayload.body).toContain('Assignee agent: implementation-architect');
    expect(jiraPayload.fields.summary).toContain('Implement ticket dispatch flow');
    expect(jiraPayload.fields.description).toContain('Assignee agent: implementation-architect');
    expect(nextTasks[0].ticket_dispatch).toMatchObject({
      work_item_id: manifest.records[0].work_item_id,
      targets: ['workitem', 'github', 'jira'],
      live_targets: [],
      task_model_hint: expect.objectContaining({
        model_id: 'openai:gpt-5.4-mini',
        tier: 'small',
        effort: 'low',
      }),
    });
    expect(manifest.records[0]).toMatchObject({
      task_model_hint: expect.objectContaining({
        model_id: 'openai:gpt-5.4-mini',
        tier: 'small',
        effort: 'low',
      }),
    });
    const missionState = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    expect(missionState.context?.last_action).toBe('Dispatched ticket task-1');
    expect(missionState.context?.ticket_dispatch_summary?.task_id).toBe('task-1');
    expect(missionState.context?.ticket_dispatch_summary?.work_item_id).toBe(
      manifest.records[0].work_item_id
    );
    expect(missionState.context?.ticket_dispatch_summary?.task_model_hint).toMatchObject({
      model_id: 'openai:gpt-5.4-mini',
      tier: 'small',
      effort: 'low',
    });
    expect(missionState.history.at(-1)?.event).toBe('RECORD_TASK');
    expect(safeExistsSync(`${missionPath}/coordination/events/ticket-events.jsonl`)).toBe(true);
    expect(safeExistsSync(`${missionPath}/coordination/tickets/dispatch-manifest.json`)).toBe(true);
  });

  it('rejects tasks without an assigned owner or enough detail', async () => {
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-1',
            status: 'planned',
            description: 'Do it.',
          },
        ],
        null,
        2
      )
    );

    const manifest = await dispatchMissionTickets(makeMissionState(), {
      targets: ['workitem', 'github', 'jira'],
    });

    expect(manifest.ticket_count).toBe(1);
    expect(manifest.records[0]).toMatchObject({
      status: 'failed',
    });
    expect(manifest.records[0].notes).toEqual(
      expect.arrayContaining([
        'missing assigned_to.role',
        'missing assigned_to.agent_id',
        'task description too short',
        'missing deliverable or target_path',
      ])
    );
    expect(safeExistsSync(`${missionPath}/coordination/tickets/github/task-1.json`)).toBe(false);
    expect(safeExistsSync(`${missionPath}/coordination/tickets/jira/task-1.json`)).toBe(false);
  });
});
