import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearWorkCoordinationStore,
  createWorkItem,
  listWorkItems,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  setWorkCoordinationNamespace,
} from '@agent/core';
import type { MissionState } from './mission-types.js';
import { dispatchMissionTickets } from './mission-ticket-dispatch.js';
import { dispatchMissionWorkItems } from './mission-workitem-dispatch.js';

const missionId = 'MSN-WORKITEM-DISPATCH-001';
const missionPath = pathResolver.missionDir(missionId, 'public');

function makeMissionState(): MissionState {
  return {
    mission_id: missionId,
    mission_type: 'development',
    tier: 'public',
    status: 'active',
    execution_mode: 'local',
    relationships: {
      project: {
        project_id: missionId,
        project_path: `active/projects/public/shared/${missionId}/project-os`,
        relationship_type: 'supports',
        affected_artifacts: [],
        gate_impact: 'informational',
        traceability_refs: [],
        note: 'Work item dispatch verification',
      },
    },
    priority: 3,
    assigned_persona: 'worker',
    confidence_score: 1,
    git: {
      branch: 'mission/workitem-dispatch',
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
  setWorkCoordinationNamespace('mission-workitem-dispatch-test');
  clearWorkCoordinationStore();
  if (!safeExistsSync(missionPath)) safeMkdir(missionPath, { recursive: true });
});

afterEach(() => {
  clearWorkCoordinationStore();
  safeRmSync(missionPath, { recursive: true, force: true });
  setWorkCoordinationNamespace(null);
});

describe('mission work item dispatch', () => {
  it('routes a work item to the assigned agent and records the response', async () => {
    createWorkItem({
      title: `${missionId}: Draft the outline`,
      description: 'Draft the presentation outline with slide titles, bullet points, and speaker notes.',
      status: 'ready',
      source: 'local',
      sourceRef: `mission:${missionId}:task-1`,
      projectId: missionId,
      assigneePeerId: 'sovereign-brain',
      labels: [`mission:${missionId}`, 'team_role:product_strategist', 'ticket:workitem'],
      metadata: {
        mission_id: missionId,
        team_role: 'product_strategist',
        deliverable: 'deliverables/outline.md',
        target_path: 'deliverables/outline.md',
      },
    });

    const manifest = await dispatchMissionWorkItems(makeMissionState(), {
      mode: 'agent',
      finalStatus: 'review',
    }, {
      routeA2A: vi.fn(async () => ({
        a2a_version: '1.0',
        header: {
          msg_id: 'RES-1',
          sender: 'sovereign-brain',
          receiver: 'kyberion:workitem-dispatcher',
          performative: 'result' as const,
          timestamp: new Date().toISOString(),
        },
        payload: {
          text: 'agent completed the outline',
        },
      })),
    });

    expect(manifest.work_item_count).toBe(1);
    expect(manifest.records[0]).toMatchObject({
      item_id: expect.any(String),
      execution_mode: 'agent',
      status: 'updated',
      work_item_status_after: 'review',
    });

    const items = listWorkItems({ projectId: missionId, source: 'local' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      status: 'review',
      assignee_peer_id: 'sovereign-brain',
    });
    expect(items[0].metadata).toMatchObject({
      last_dispatch_mode: 'agent',
      last_dispatch_mission_id: missionId,
    });

    const responseFile = `${missionPath}/evidence/workitem-dispatch-${manifest.records[0].item_id}.json`;
    expect(safeExistsSync(responseFile)).toBe(true);
    const response = JSON.parse(safeReadFile(responseFile, { encoding: 'utf8' }) as string);
    expect(response).toMatchObject({
      mission_id: missionId,
      item_id: manifest.records[0].item_id,
      execution_mode: 'agent',
    });
    expect(response.context_pack_path).toContain('/coordination/context-packs/');
    expect(response.prompt).toContain('Mission context pack (scoped, minimal, role-specific).');
    expect(response.response_text).toContain('agent completed the outline');
    expect(safeExistsSync(`${missionPath}/coordination/events/workitem-dispatch.jsonl`)).toBe(true);
  });

  it('reflects completed work item results back onto ticket artifacts', async () => {
    safeWriteFile(`${missionPath}/NEXT_TASKS.json`, JSON.stringify([
      {
        task_id: 'task-1',
        status: 'planned',
        assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
        description: 'Implement the reflected ticket workflow',
        deliverable: 'evidence/ticket-reflection.md',
        target_path: 'evidence/ticket-reflection.md',
      },
    ], null, 2));

    await dispatchMissionTickets(makeMissionState(), {
      targets: ['workitem', 'github', 'jira'],
    });

    const manifest = await dispatchMissionWorkItems(makeMissionState(), {
      mode: 'subagent',
      finalStatus: 'done',
    }, {
      delegateTask: vi.fn(async () => 'subagent completed the reflected ticket workflow'),
    });

    const replyPath = `${missionPath}/coordination/tickets/replies/task-1.json`;
    expect(safeExistsSync(replyPath)).toBe(true);
    const reply = JSON.parse(safeReadFile(replyPath, { encoding: 'utf8' }) as string);
    expect(reply).toMatchObject({
      mission_id: missionId,
      task_id: 'task-1',
      ticket_state: 'done',
    });
    expect(reply.context_pack_path).toContain('/coordination/context-packs/');

    const ticketManifest = JSON.parse(safeReadFile(`${missionPath}/coordination/tickets/dispatch-manifest.json`, { encoding: 'utf8' }) as string);
    expect(ticketManifest.records[0]).toMatchObject({
      task_id: 'task-1',
      reflection_status: 'done',
      ticket_state_after: 'done',
    });

    const nextTasks = JSON.parse(safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string);
    expect(nextTasks[0].ticket_dispatch).toMatchObject({
      result_status: 'done',
      review_required: false,
      blocked: false,
    });

    const githubArtifact = JSON.parse(safeReadFile(`${missionPath}/coordination/tickets/github/task-1.json`, { encoding: 'utf8' }) as string);
    expect(githubArtifact.state).toBe('closed');
    expect(Array.isArray(githubArtifact.comments)).toBe(true);
    expect(githubArtifact.comments.length).toBeGreaterThan(0);

    const jiraArtifact = JSON.parse(safeReadFile(`${missionPath}/coordination/tickets/jira/task-1.json`, { encoding: 'utf8' }) as string);
    expect(jiraArtifact.fields.status.name).toBe('Done');
    expect(Array.isArray(jiraArtifact.comments)).toBe(true);
    expect(jiraArtifact.comments.length).toBeGreaterThan(0);

    expect(manifest.records[0]).toMatchObject({
      reflection_status: 'done',
      ticket_state_after: 'done',
      work_item_status_after: 'done',
    });
  });

  it('falls back to subagent execution when requested', async () => {
    createWorkItem({
      title: `${missionId}: Write the summary`,
      description: 'Write the mission summary and evidence notes for the review package.',
      status: 'ready',
      source: 'local',
      sourceRef: `mission:${missionId}:task-2`,
      projectId: missionId,
      assigneePeerId: 'implementation-architect',
      labels: [`mission:${missionId}`, 'team_role:reviewer', 'ticket:workitem'],
      metadata: {
        mission_id: missionId,
        team_role: 'reviewer',
        deliverable: 'evidence/summary.md',
        target_path: 'evidence/summary.md',
      },
    });

    const manifest = await dispatchMissionWorkItems(makeMissionState(), {
      mode: 'subagent',
      finalStatus: 'done',
    }, {
      delegateTask: vi.fn(async () => 'subagent completed the summary'),
    });

    expect(manifest.records[0]).toMatchObject({
      execution_mode: 'subagent',
      work_item_status_after: 'done',
    });

    const items = listWorkItems({ projectId: missionId, source: 'local' });
    expect(items[0]).toMatchObject({
      status: 'done',
    });
  });

  it('rejects under-specified tasks before creating dispatch artifacts', async () => {
    createWorkItem({
      title: `${missionId}: Too vague`,
      description: 'Do it.',
      status: 'ready',
      source: 'local',
      sourceRef: `mission:${missionId}:task-3`,
      projectId: missionId,
      labels: [`mission:${missionId}`, 'team_role:implementer', 'ticket:workitem'],
      metadata: {
        mission_id: missionId,
        team_role: 'implementer',
      },
    });

    const manifest = await dispatchMissionWorkItems(makeMissionState(), {
      mode: 'subagent',
    }, {
      delegateTask: vi.fn(async () => 'should not run'),
    });

    expect(manifest.records[0]).toMatchObject({
      status: 'failed',
    });
    expect(manifest.records[0].notes).toContain('missing assignee_peer_id');
    expect(manifest.records[0].response_path).toBeUndefined();
    expect(safeExistsSync(`${missionPath}/evidence/workitem-dispatch-${manifest.records[0].item_id}.json`)).toBe(false);
  });
});
