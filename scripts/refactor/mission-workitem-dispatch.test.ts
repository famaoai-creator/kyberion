import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as nodePath from 'node:path';

import {
  artifactOwnershipRegistryPath,
  appendArtifactOwnershipRecord,
  createArtifactOwnershipRecord,
  clearWorkCoordinationStore,
  createWorkItem,
  hashArtifactForReview,
  listWorkItems,
  loadArtifactReviewReceipt,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  setWorkCoordinationNamespace,
  updateWorkItem,
} from '@agent/core';
import type { MissionState } from './mission-types.js';
import { dispatchMissionTickets } from './mission-ticket-dispatch.js';
import { dispatchMissionWorkItems } from './mission-workitem-dispatch.js';

const missionId = 'MSN-WORKITEM-DISPATCH-001';
const missionPath = pathResolver.missionDir(missionId, 'public');
const artifactRegistryPath = artifactOwnershipRegistryPath();
let originalArtifactRegistryRaw: string | null = null;

beforeEach(() => {
  if (safeExistsSync(artifactRegistryPath) && originalArtifactRegistryRaw === null) {
    originalArtifactRegistryRaw = safeReadFile(artifactRegistryPath, {
      encoding: 'utf8',
    }) as string;
  }
});

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

function makeLinkedProjectMissionState(input: {
  missionId: string;
  projectId: string;
  projectPath: string;
}): MissionState {
  return {
    ...makeMissionState(),
    mission_id: input.missionId,
    relationships: {
      project: {
        project_id: input.projectId,
        project_path: input.projectPath,
        relationship_type: 'supports',
        affected_artifacts: [],
        gate_impact: 'informational',
        traceability_refs: [],
        note: 'Linked project work item dispatch verification',
      },
    },
  };
}

function makeTaskResultText(input: {
  summary: string;
  artifacts?: Array<{ path: string; kind: string }>;
  verification_done?: string[];
  gaps?: string[];
  needs?: string[];
  review_findings?: Array<{
    severity: 'must_fix' | 'should_fix' | 'nit';
    location: string;
    instruction: string;
  }>;
  extraText?: string;
}): string {
  return [
    '```task_result',
    JSON.stringify({
      summary: input.summary,
      artifacts: input.artifacts || [],
      verification_done: input.verification_done || [],
      gaps: input.gaps || [],
      needs: input.needs || [],
      ...(input.review_findings ? { review_findings: input.review_findings } : {}),
    }),
    '```',
    input.extraText || '',
  ]
    .filter(Boolean)
    .join('\n');
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
  if (originalArtifactRegistryRaw !== null) {
    safeWriteFile(artifactRegistryPath, originalArtifactRegistryRaw);
    return;
  }
  if (safeExistsSync(artifactRegistryPath)) safeRmSync(artifactRegistryPath);
});

describe('mission work item dispatch', () => {
  it('binds a canonical reviewer dispatch to the reconciled artifact hash', async () => {
    safeMkdir(`${missionPath}/deliverables`, { recursive: true });
    safeWriteFile(`${missionPath}/deliverables/reconciled.ts`, 'export const value = 1;\n');
    safeWriteFile(`${missionPath}/evidence/REVIEW-implementation.md`, '# Review\n');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'implementation',
            status: 'completed',
            assigned_to: { role: 'implementer', agent_id: 'sovereign-brain' },
            deliverable: 'evidence/implementation.md',
            reconciliation: {
              evidence: [{ path: 'deliverables/reconciled.ts', kind: 'artifact' }],
            },
          },
          {
            task_id: 'review-implementation',
            status: 'planned',
            assigned_to: { role: 'reviewer' },
            deliverable: 'evidence/REVIEW-implementation.md',
            review_target: 'implementation',
            acceptance_criteria: ['no blocking defects remain'],
            risk: 'medium',
          },
        ],
        null,
        2
      )
    );
    createWorkItem({
      title: `${missionId}: Review the reconciled implementation`,
      description:
        'Review the reconciled implementation for correctness, security, regressions, and acceptance evidence.',
      status: 'ready',
      source: 'local',
      sourceRef: `mission:${missionId}:review-implementation`,
      projectId: missionId,
      assigneePeerId: 'implementation-architect',
      labels: [`mission:${missionId}`, 'team_role:reviewer', 'ticket:workitem'],
      metadata: {
        mission_id: missionId,
        task_id: 'review-implementation',
        team_role: 'reviewer',
        deliverable: 'evidence/REVIEW-implementation.md',
        review_target: 'implementation',
        acceptance_criteria: ['no blocking defects remain'],
        risk: 'medium',
        estimated_scope: 'S',
      },
    });
    const delegateTask = vi.fn(async () =>
      makeTaskResultText({
        summary: 'Reviewed the reconciled implementation and recorded the structured verdict.',
        artifacts: [{ path: 'evidence/REVIEW-implementation.md', kind: 'markdown' }],
        verification_done: ['Checked the current artifact hash and regression tests.'],
        gaps: [],
        needs: [],
        review_findings: [],
      })
    );

    const manifest = await dispatchMissionWorkItems(
      makeMissionState(),
      { mode: 'subagent', finalStatus: 'done' },
      { delegateTask }
    );

    expect(manifest.records[0]).toMatchObject({
      reflection_status: 'done',
      work_item_status_after: 'done',
      artifact_review_receipt: expect.stringMatching(/^evidence\/reviews\//u),
      assignee_peer_id: 'implementation-architect',
    });
    expect(manifest.records[0].notes.join('\n')).toContain(
      'acceptance criteria satisfied by approved artifact review receipt'
    );
    const delegateCall = delegateTask.mock.calls[0] as unknown as [string];
    const prompt = String(delegateCall?.[0] || '');
    expect(prompt).toContain('deliverables/reconciled.ts');
    expect(prompt).toContain('code-reviewer');

    const tasks = JSON.parse(
      String(safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }))
    ) as Array<{
      status?: string;
      assigned_to?: { role?: string; agent_id?: string };
      reconciliation?: { evidence?: Array<{ path?: string }> };
      artifact_review_profile?: {
        artifact_kind?: string;
        required_reviewer_roles?: string[];
        implementer_agent_ids?: string[];
      };
      artifact_review_receipt?: string;
    }>;
    expect(tasks[0].reconciliation?.evidence?.[0]?.path).toBe('deliverables/reconciled.ts');
    expect(tasks[1]).toMatchObject({
      status: 'completed',
      assigned_to: { role: 'reviewer', agent_id: 'implementation-architect' },
      artifact_review_profile: {
        artifact_kind: 'code',
        required_reviewer_roles: ['code-reviewer'],
        implementer_agent_ids: ['sovereign-brain'],
      },
      artifact_review_receipt: expect.stringMatching(/^evidence\/reviews\//u),
    });
    const receipt = loadArtifactReviewReceipt(
      nodePath.join(missionPath, String(tasks[1].artifact_review_receipt))
    );
    expect(receipt).toMatchObject({
      review_task_id: 'review-implementation',
      review_target_task_id: 'implementation',
      artifact: {
        path: expect.stringContaining('deliverables/reconciled.ts'),
        sha256: hashArtifactForReview(`${missionPath}/deliverables/reconciled.ts`),
        kind: 'code',
      },
      reviewer: {
        agent_id: 'implementation-architect',
        specialist_roles: ['code-reviewer'],
        independent_from: ['sovereign-brain'],
        independence_verified: true,
      },
      verdict: 'approved',
    });
  });

  it('selects only tasks whose canonical mission dependencies are complete', async () => {
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          { task_id: 'completed-prerequisite', status: 'completed' },
          {
            task_id: 'ready-task',
            status: 'planned',
            dependencies: ['completed-prerequisite'],
          },
          {
            task_id: 'delivery-task',
            status: 'planned',
            dependencies: ['ready-task'],
          },
          {
            task_id: 'retrospective-task',
            status: 'planned',
            dependencies: ['delivery-task'],
          },
        ],
        null,
        2
      )
    );
    for (const [taskId, title, dependencies] of [
      ['ready-task', 'Ready task', ['completed-prerequisite']],
      ['delivery-task', 'Delivery task', ['ready-task']],
      ['retrospective-task', 'Retrospective task', ['delivery-task']],
    ] as const) {
      createWorkItem({
        title: `${missionId}: ${title}`,
        description: `Execute ${title} after all canonical mission dependencies are complete.`,
        status: 'ready',
        source: 'local',
        sourceRef: `mission:${missionId}:${taskId}`,
        projectId: missionId,
        assigneePeerId: 'implementation-architect',
        labels: [`mission:${missionId}`, 'team_role:implementer', 'ticket:workitem'],
        metadata: {
          mission_id: missionId,
          task_id: taskId,
          team_role: 'implementer',
          deliverable: `evidence/${taskId}.md`,
          dependencies,
        },
      });
    }
    const delegateTask = vi.fn(async () =>
      makeTaskResultText({
        summary: 'Completed the only dependency-ready task.',
        artifacts: [{ path: 'evidence/ready-task.md', kind: 'markdown' }],
        verification_done: ['Confirmed canonical dependencies before execution.'],
        gaps: [],
        needs: [],
      })
    );

    const manifest = await dispatchMissionWorkItems(
      makeMissionState(),
      { mode: 'subagent', limit: 1, statuses: ['ready'], finalStatus: 'done' },
      { delegateTask }
    );

    expect(delegateTask).toHaveBeenCalledTimes(1);
    expect(manifest.records).toHaveLength(1);
    expect(manifest.records[0].title).toContain('Ready task');
    const tasks = JSON.parse(
      String(safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }))
    ) as Array<{ task_id: string; status?: string }>;
    expect(tasks.find((task) => task.task_id === 'ready-task')?.status).toBe('completed');
    expect(tasks.find((task) => task.task_id === 'delivery-task')?.status).toBe('planned');
    expect(tasks.find((task) => task.task_id === 'retrospective-task')?.status).toBe('planned');
  });

  it('routes a work item to the assigned agent and records the response', async () => {
    createWorkItem({
      title: `${missionId}: Draft the outline`,
      description:
        'Draft the presentation outline with slide titles, bullet points, and speaker notes.',
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
        risk: 'low',
        estimated_scope: 'S',
      },
    });

    const routeA2A = vi.fn(async () => ({
      a2a_version: '1.0',
      header: {
        msg_id: 'RES-1',
        sender: 'sovereign-brain',
        receiver: 'kyberion:workitem-dispatcher',
        performative: 'result' as const,
        timestamp: new Date().toISOString(),
      },
      payload: {
        text: makeTaskResultText({
          summary: 'Completed the outline and stored it in the mission evidence directory.',
          artifacts: [{ path: 'deliverables/outline.md', kind: 'markdown' }],
          verification_done: ['Reviewed outline structure against the requested slide sequence.'],
          gaps: [],
          needs: [],
          extraText: 'agent completed the outline',
        }),
      },
    }));
    const manifest = await dispatchMissionWorkItems(
      makeMissionState(),
      {
        mode: 'agent',
        finalStatus: 'review',
      },
      {
        routeA2A,
      }
    );

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
      last_task_model_hint: expect.objectContaining({
        model_id: 'openai:gpt-5.4-mini',
        tier: 'small',
        effort: 'low',
      }),
    });
    const routeCall = routeA2A.mock.calls[0] as unknown as [any];
    expect(routeCall).toBeDefined();
    expect(routeCall[0].payload.text).toContain('Model hint: openai:gpt-5.4-mini (small/low)');
    expect(routeCall[0].payload.context).toMatchObject({
      task_model_hint: expect.objectContaining({
        model_id: 'openai:gpt-5.4-mini',
        tier: 'small',
        effort: 'low',
      }),
    });

    const responseFile = `${missionPath}/evidence/workitem-dispatch-${manifest.records[0].item_id}.json`;
    expect(safeExistsSync(responseFile)).toBe(true);
    const response = JSON.parse(safeReadFile(responseFile, { encoding: 'utf8' }) as string);
    expect(response).toMatchObject({
      mission_id: missionId,
      item_id: manifest.records[0].item_id,
      execution_mode: 'agent',
      task_model_hint: expect.objectContaining({
        model_id: 'openai:gpt-5.4-mini',
        tier: 'small',
        effort: 'low',
      }),
    });
    expect(response.prompt).toContain('Model hint: openai:gpt-5.4-mini (small/low)');
    expect(response.context_pack_path).toContain('/coordination/context-packs/');
    expect(response.prompt).toContain('Mission context pack (scoped, minimal, role-specific).');
    expect(response.prompt).toContain('Fast-tier enforcement:');
    expect(response.response_text).toContain('agent completed the outline');
    expect(safeExistsSync(`${missionPath}/coordination/events/workitem-dispatch.jsonl`)).toBe(true);
  });

  it('treats fast-tier work as incomplete when verification evidence is missing', async () => {
    createWorkItem({
      title: `${missionId}: Draft the fast-tier outline`,
      description:
        'Draft the compact outline and keep the result schema-driven for the fast-tier dispatch.',
      status: 'ready',
      source: 'local',
      sourceRef: `mission:${missionId}:task-fast-tier`,
      projectId: missionId,
      assigneePeerId: 'sovereign-brain',
      labels: [`mission:${missionId}`, 'team_role:product_strategist', 'ticket:workitem'],
      metadata: {
        mission_id: missionId,
        team_role: 'product_strategist',
        deliverable: 'deliverables/fast-tier-outline.md',
        target_path: 'deliverables/fast-tier-outline.md',
        risk: 'low',
        estimated_scope: 'S',
      },
    });

    const routeA2A = vi.fn(async () => ({
      a2a_version: '1.0',
      header: {
        msg_id: 'RES-FAST-1',
        sender: 'sovereign-brain',
        receiver: 'kyberion:workitem-dispatcher',
        performative: 'result' as const,
        timestamp: new Date().toISOString(),
      },
      payload: {
        text: makeTaskResultText({
          summary: 'Completed the outline but left out verification details.',
          artifacts: [{ path: 'deliverables/fast-tier-outline.md', kind: 'markdown' }],
          verification_done: [],
          gaps: [],
          needs: [],
          extraText: 'fast-tier outline complete',
        }),
      },
    }));

    const manifest = await dispatchMissionWorkItems(
      makeMissionState(),
      {
        mode: 'agent',
        finalStatus: 'done',
      },
      {
        routeA2A,
      }
    );

    expect(manifest.records[0]).toMatchObject({
      work_item_status_after: 'review',
    });
    expect(manifest.records[0].notes).toContain('fast-tier verification incomplete');
    const routeCall = routeA2A.mock.calls[0] as unknown as [any];
    expect(routeCall[0].payload.text).toContain('Fast-tier enforcement:');
  });

  it('downgrades completion when acceptance criteria are missing from the response', async () => {
    createWorkItem({
      title: `${missionId}: Validate acceptance criteria`,
      description:
        'Validate the acceptance criteria gate and ensure unmet criteria do not become done.',
      status: 'ready',
      source: 'local',
      sourceRef: `mission:${missionId}:task-acceptance`,
      projectId: missionId,
      assigneePeerId: 'sovereign-brain',
      labels: [`mission:${missionId}`, 'team_role:product_strategist', 'ticket:workitem'],
      metadata: {
        mission_id: missionId,
        team_role: 'product_strategist',
        deliverable: 'deliverables/acceptance-check.md',
        target_path: 'deliverables/acceptance-check.md',
        acceptance_criteria: ['mention the acceptance gate'],
        risk: 'low',
        estimated_scope: 'S',
      },
    });

    const manifest = await dispatchMissionWorkItems(
      makeMissionState(),
      {
        mode: 'agent',
        finalStatus: 'done',
      },
      {
        routeA2A: vi.fn(async () => ({
          a2a_version: '1.0',
          header: {
            msg_id: 'RES-AC-1',
            sender: 'sovereign-brain',
            receiver: 'kyberion:workitem-dispatcher',
            performative: 'result' as const,
            timestamp: new Date().toISOString(),
          },
          payload: {
            text: makeTaskResultText({
              summary:
                'Completed the acceptance check but did not include the requested gate phrase.',
              artifacts: [{ path: 'deliverables/acceptance-check.md', kind: 'markdown' }],
              verification_done: ['Compared the output against the acceptance criteria.'],
              gaps: ['The gate phrase is absent.'],
              needs: [],
              extraText: 'The task was completed, but the gate phrase is absent.',
            }),
          },
        })),
      }
    );

    expect(manifest.records[0]).toMatchObject({
      work_item_status_after: 'review',
      reflection_status: 'review',
    });

    const replyPath = String(
      manifest.records[0].reflection_path ||
        `${missionPath}/coordination/tickets/replies/${manifest.records[0].item_id}.json`
    );
    const reply = JSON.parse(safeReadFile(replyPath, { encoding: 'utf8' }) as string);
    expect(reply).toMatchObject({
      ticket_state: 'review',
      acceptance_criteria_satisfied: false,
    });
    expect(reply.notes.join('\n')).toContain('acceptance criteria not met');
  });

  it('auto-rounds: retries blocked items in a later round and stops on no progress', async () => {
    createWorkItem({
      title: `${missionId}: Round-trip work`,
      description: 'Complete the work; the first round returns empty (transient failure).',
      status: 'ready',
      source: 'local',
      sourceRef: `mission:${missionId}:task-rounds`,
      projectId: missionId,
      assigneePeerId: 'sovereign-brain',
      labels: [`mission:${missionId}`, 'team_role:product_strategist', 'ticket:workitem'],
      metadata: {
        mission_id: missionId,
        team_role: 'product_strategist',
        deliverable: 'deliverables/rounds.md',
        target_path: 'deliverables/rounds.md',
        risk: 'low',
        estimated_scope: 'S',
      },
    });

    const delegateTask = vi
      .fn()
      // round 1: empty twice (initial + the empty-response retry) → blocked
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      // round 2 succeeds
      .mockResolvedValue(
        makeTaskResultText({
          summary: 'Completed on the second dispatch round.',
          artifacts: [],
          verification_done: ['done'],
          gaps: [],
          needs: [],
        })
      );

    const manifest = await dispatchMissionWorkItems(
      makeMissionState(),
      { mode: 'subagent', finalStatus: 'done', rounds: 3 },
      { delegateTask }
    );

    // round1 (2 calls incl. retry) + round2 (1 call) — round3 skipped (no items left)
    expect(delegateTask.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(manifest.records[0]).toMatchObject({
      task_result: expect.objectContaining({
        summary: 'Completed on the second dispatch round.',
      }),
    });
  });

  it('re-requests task_result once when the initial response is unstructured', async () => {
    createWorkItem({
      title: `${missionId}: Structure the task result`,
      description: 'Return a structured task_result block and capture the response summary.',
      status: 'ready',
      source: 'local',
      sourceRef: `mission:${missionId}:task-structured`,
      projectId: missionId,
      assigneePeerId: 'sovereign-brain',
      labels: [`mission:${missionId}`, 'team_role:product_strategist', 'ticket:workitem'],
      metadata: {
        mission_id: missionId,
        team_role: 'product_strategist',
        deliverable: 'deliverables/structured-result.md',
        target_path: 'deliverables/structured-result.md',
        risk: 'low',
        estimated_scope: 'S',
      },
    });

    const delegateTask = vi
      .fn()
      .mockResolvedValueOnce('plain text without a structured block')
      .mockResolvedValueOnce(
        makeTaskResultText({
          summary: 'Captured the structured task result after retry.',
          artifacts: [{ path: 'deliverables/structured-result.md', kind: 'markdown' }],
          verification_done: ['Responded with the required task_result block.'],
          gaps: [],
          needs: [],
        })
      );

    const manifest = await dispatchMissionWorkItems(
      makeMissionState(),
      {
        mode: 'subagent',
        finalStatus: 'review',
      },
      {
        delegateTask,
      }
    );

    expect(delegateTask).toHaveBeenCalledTimes(2);
    expect(manifest.records[0]).toMatchObject({
      task_result: expect.objectContaining({
        summary: 'Captured the structured task result after retry.',
      }),
    });

    const responseFile = `${missionPath}/evidence/workitem-dispatch-${manifest.records[0].item_id}.json`;
    const response = JSON.parse(safeReadFile(responseFile, { encoding: 'utf8' }) as string);
    expect(response.task_result).toMatchObject({
      summary: 'Captured the structured task result after retry.',
    });
  });

  it('blocks the work item and records a clarification packet when task_result needs remain', async () => {
    createWorkItem({
      title: `${missionId}: Request missing inputs`,
      description:
        'Return the unresolved inputs as a clarification packet and keep the item blocked.',
      status: 'ready',
      source: 'local',
      sourceRef: `mission:${missionId}:task-needs-input`,
      projectId: missionId,
      assigneePeerId: 'sovereign-brain',
      labels: [`mission:${missionId}`, 'team_role:product_strategist', 'ticket:workitem'],
      metadata: {
        mission_id: missionId,
        team_role: 'product_strategist',
        deliverable: 'deliverables/needs-input.md',
        target_path: 'deliverables/needs-input.md',
        risk: 'low',
        estimated_scope: 'S',
      },
    });

    const delegateTask = vi
      .fn()
      .mockResolvedValueOnce(
        makeTaskResultText({
          summary: 'The work is not ready without more context.',
          artifacts: [],
          verification_done: ['Captured the unresolved inputs.'],
          gaps: ['The scope is incomplete.'],
          needs: ['project_brief', 'acceptance_criteria'],
        })
      )
      .mockResolvedValueOnce(
        makeTaskResultText({
          summary: 'The work is still blocked pending missing inputs.',
          artifacts: [],
          verification_done: ['Repeated the unresolved inputs.'],
          gaps: ['The scope is still incomplete.'],
          needs: ['project_brief', 'acceptance_criteria'],
        })
      );

    const manifest = await dispatchMissionWorkItems(
      makeMissionState(),
      {
        mode: 'subagent',
        finalStatus: 'review',
      },
      {
        delegateTask,
      }
    );

    expect(delegateTask).toHaveBeenCalledTimes(2);
    expect(manifest.records[0]).toMatchObject({
      work_item_status_after: 'blocked',
      clarification_packet: expect.objectContaining({
        kind: 'operator-interaction-packet',
        interaction_type: 'clarification',
      }),
    });
    expect(manifest.records[0].clarification_packet_path).toBeDefined();
    expect(manifest.records[0].notes).toContain('needs_input');

    const clarificationPath = String(
      manifest.records[0].clarification_packet_path ||
        `${missionPath}/evidence/workitem-clarification-${manifest.records[0].item_id}.json`
    );
    expect(safeExistsSync(clarificationPath)).toBe(true);
    const clarification = JSON.parse(
      safeReadFile(clarificationPath, { encoding: 'utf8' }) as string
    );
    expect(clarification).toMatchObject({
      mission_id: missionId,
      item_id: manifest.records[0].item_id,
      status: 'needs_input',
      clarification_packet: expect.objectContaining({
        kind: 'operator-interaction-packet',
        interaction_type: 'clarification',
      }),
    });
    expect(Array.isArray(clarification.clarification_packet.questions)).toBe(true);
    expect(clarification.clarification_packet.questions.length).toBeGreaterThan(0);
    expect(clarification.clarification_packet.questions[0].question).toContain('project brief');

    const responseFile = `${missionPath}/evidence/workitem-dispatch-${manifest.records[0].item_id}.json`;
    const response = JSON.parse(safeReadFile(responseFile, { encoding: 'utf8' }) as string);
    expect(response.clarification_packet).toMatchObject({
      kind: 'operator-interaction-packet',
      interaction_type: 'clarification',
    });
    expect(response.clarification_packet_path).toBe(clarificationPath);
  });

  it('requires an independent reviewer for high-stakes work and keeps the item in review when refuted', async () => {
    createWorkItem({
      title: `${missionId}: Review the high-stakes change`,
      description:
        'Implement the high-stakes change with explicit reviewer sign-off and keep the outcome blocked until the reviewer approves.',
      status: 'ready',
      source: 'local',
      sourceRef: `mission:${missionId}:task-high-stakes`,
      projectId: missionId,
      assigneePeerId: 'sovereign-brain',
      labels: [`mission:${missionId}`, 'team_role:implementer', 'ticket:workitem'],
      metadata: {
        mission_id: missionId,
        team_role: 'implementer',
        deliverable: 'deliverables/high-stakes.md',
        target_path: 'deliverables/high-stakes.md',
        acceptance_criteria: ['mention the reviewer sign-off'],
        risk: 'high_stakes',
        estimated_scope: 'L',
      },
    });

    const delegateTask = vi.fn(async (_instruction: string, context?: string) => {
      if (String(context || '').startsWith('workitem-review:')) {
        return JSON.stringify({
          approved: false,
          refuted: true,
          findings: ['The response does not show an independent reviewer sign-off.'],
          rationale: 'High-stakes work must stay in review until a separate reviewer approves it.',
        });
      }
      return makeTaskResultText({
        summary: 'Implemented the high-stakes change, but reviewer sign-off is still missing.',
        artifacts: [{ path: 'deliverables/high-stakes.md', kind: 'markdown' }],
        verification_done: ['Produced the requested change artifact.'],
        gaps: ['Reviewer sign-off is missing.'],
        needs: [],
        extraText: 'implementation complete with reviewer sign-off missing',
      });
    });

    const manifest = await dispatchMissionWorkItems(
      makeMissionState(),
      {
        mode: 'subagent',
        finalStatus: 'done',
      },
      {
        delegateTask,
      }
    );

    expect(delegateTask).toHaveBeenCalledTimes(2);
    expect(manifest.records[0]).toMatchObject({
      reviewer_status: 'refuted',
      reflection_status: 'review',
      work_item_status_after: 'review',
    });

    const reviewArtifact = JSON.parse(
      safeReadFile(`${missionPath}/evidence/workitem-review-${manifest.records[0].item_id}.json`, {
        encoding: 'utf8',
      }) as string
    );
    expect(reviewArtifact).toMatchObject({
      item_id: manifest.records[0].item_id,
      verdict: expect.objectContaining({
        approved: false,
        refuted: true,
      }),
    });

    const responseArtifact = JSON.parse(
      safeReadFile(
        `${missionPath}/evidence/workitem-dispatch-${manifest.records[0].item_id}.json`,
        { encoding: 'utf8' }
      ) as string
    );
    expect(responseArtifact).toMatchObject({
      reviewer_status: 'refuted',
    });
    expect(responseArtifact.prompt).toContain(
      'Mission context pack (scoped, minimal, role-specific).'
    );
    expect(responseArtifact.response_text).toContain('implementation complete');
  });

  it('injects reusable artifact hints into the dispatched prompt', async () => {
    appendArtifactOwnershipRecord(
      createArtifactOwnershipRecord({
        artifact_id: 'ART-WORKITEM-BASE',
        project_id: missionId,
        mission_id: 'MSN-WORKITEM-BASE',
        kind: 'markdown',
        storage_class: 'artifact_store',
        path: 'active/shared/artifacts/workitem-base.md',
        created_at: '2026-06-03T00:00:00.000Z',
      })
    );
    appendArtifactOwnershipRecord(
      createArtifactOwnershipRecord({
        artifact_id: 'ART-WORKITEM-REVISION',
        project_id: missionId,
        mission_id: 'MSN-WORKITEM-REVISION',
        kind: 'markdown',
        storage_class: 'artifact_store',
        path: 'active/shared/artifacts/workitem-revision.md',
        created_at: '2026-06-04T00:00:00.000Z',
        evidence_refs: ['mission:MSN-WORKITEM-REVISION'],
      })
    );

    createWorkItem({
      title: `${missionId}: Revise the outline with existing artifact reuse`,
      description:
        'Revise the outline and explicitly reuse the latest canonical markdown artifact.',
      status: 'ready',
      source: 'local',
      sourceRef: `mission:${missionId}:task-1-reuse`,
      projectId: missionId,
      assigneePeerId: 'sovereign-brain',
      labels: [`mission:${missionId}`, 'team_role:product_strategist', 'ticket:workitem'],
      metadata: {
        mission_id: missionId,
        team_role: 'product_strategist',
        deliverable: 'deliverables/outline.md',
        target_path: 'deliverables/outline.md',
        artifact_kind: 'markdown',
      },
    });

    const manifest = await dispatchMissionWorkItems(
      makeMissionState(),
      {
        mode: 'agent',
        finalStatus: 'review',
      },
      {
        routeA2A: vi.fn(async (envelope) => ({
          a2a_version: '1.0',
          header: {
            msg_id: 'RES-REUSE-1',
            sender: 'sovereign-brain',
            receiver: 'kyberion:workitem-dispatcher',
            performative: 'result' as const,
            timestamp: new Date().toISOString(),
          },
          payload: {
            text: makeTaskResultText({
              summary: 'Reused the canonical artifact and revised the outline accordingly.',
              artifacts: [{ path: 'deliverables/outline.md', kind: 'markdown' }],
              verification_done: [
                'Confirmed the latest reusable markdown artifact was referenced.',
              ],
              gaps: [],
              needs: [],
              extraText: `${String(envelope.payload?.text || '')}\n\nartifact reuse confirmed`,
            }),
          },
        })),
      }
    );

    const responseFile = `${missionPath}/evidence/workitem-dispatch-${manifest.records[0].item_id}.json`;
    const response = JSON.parse(safeReadFile(responseFile, { encoding: 'utf8' }) as string);
    expect(response.prompt).toContain('Reusable artifact hints:');
    expect(response.prompt).toContain('ART-WORKITEM-REVISION');
    expect(response.prompt).toContain('Reusable project artifact');
    expect(response.response_text).toContain('artifact reuse confirmed');
  });

  it('records the cognitive routing decision in the dispatch artifact and prompt', async () => {
    createWorkItem({
      title: `${missionId}: Execute the deterministic pipeline`,
      description:
        'Run the known deterministic pipeline from the pipeline_ref and persist the result artifact.',
      status: 'ready',
      source: 'local',
      sourceRef: `mission:${missionId}:task-1-deterministic`,
      projectId: missionId,
      assigneePeerId: 'sovereign-brain',
      labels: [`mission:${missionId}`, 'team_role:implementer', 'ticket:workitem'],
      metadata: {
        mission_id: missionId,
        team_role: 'implementer',
        deliverable: 'deliverables/deterministic-result.md',
        target_path: 'deliverables/deterministic-result.md',
        pipeline_ref: 'pipelines/deterministic-result.json',
      },
    });

    const delegateTask = vi.fn(async (instruction: string) =>
      makeTaskResultText({
        summary: 'Executed the deterministic pipeline and returned a structured result.',
        artifacts: [{ path: 'deliverables/deterministic-result.md', kind: 'markdown' }],
        verification_done: ['Ran the deterministic pipeline instructions.'],
        gaps: [],
        needs: [],
        extraText: `subagent accepted\n${instruction}`,
      })
    );
    const manifest = await dispatchMissionWorkItems(
      makeMissionState(),
      {
        mode: 'subagent',
        finalStatus: 'review',
      },
      {
        delegateTask,
      }
    );

    expect(delegateTask).toHaveBeenCalledTimes(1);
    const prompt = String(delegateTask.mock.calls[0]?.[0] || '');
    expect(prompt).toContain('Cognitive route:');
    expect(prompt).toContain('tier=zero_llm');
    expect(prompt).toContain('deterministic_pipeline');

    expect(manifest.records[0]).toMatchObject({
      cognitive_route: {
        tier: 'zero_llm',
        backend_preference: 'deterministic_pipeline',
        deterministic_eligible: true,
      },
    });

    const responseFile = `${missionPath}/evidence/workitem-dispatch-${manifest.records[0].item_id}.json`;
    const response = JSON.parse(safeReadFile(responseFile, { encoding: 'utf8' }) as string);
    expect(response.cognitive_route).toMatchObject({
      tier: 'zero_llm',
      backend_preference: 'deterministic_pipeline',
      deterministic_eligible: true,
    });
    expect(response.cognitive_route_summary).toContain('tier=zero_llm');
  });

  it('blocks repeated identical dispatch outcomes and marks needs_attention', async () => {
    createWorkItem({
      title: `${missionId}: Repeat the same output until stopped`,
      description:
        'Repeat the same result three times so the drift watchdog can detect a loop and stop the mission work item.',
      status: 'ready',
      source: 'local',
      sourceRef: `mission:${missionId}:task-1-drift`,
      projectId: missionId,
      assigneePeerId: 'sovereign-brain',
      labels: [`mission:${missionId}`, 'team_role:implementer', 'ticket:workitem'],
      metadata: {
        mission_id: missionId,
        team_role: 'implementer',
        deliverable: 'deliverables/drift-watchdog.md',
        target_path: 'deliverables/drift-watchdog.md',
      },
    });

    const delegateTask = vi.fn(async () =>
      makeTaskResultText({
        summary: 'Repeated the same output for drift-watchdog testing.',
        artifacts: [{ path: 'deliverables/drift-watchdog.md', kind: 'markdown' }],
        verification_done: ['Compared output to the previous run.'],
        gaps: [],
        needs: [],
        extraText: 'identical result',
      })
    );

    const first = await dispatchMissionWorkItems(
      makeMissionState(),
      { mode: 'subagent', finalStatus: 'review' },
      { delegateTask }
    );
    let current = listWorkItems({ projectId: missionId, source: 'local' })[0];
    updateWorkItem({
      itemId: current.item_id,
      status: 'ready',
      metadata: {
        ...(current.metadata || {}),
        ...(first.records[0]?.drift_watchdog || {}),
      },
    });

    const second = await dispatchMissionWorkItems(
      makeMissionState(),
      { mode: 'subagent', finalStatus: 'review' },
      { delegateTask }
    );
    current = listWorkItems({ projectId: missionId, source: 'local' })[0];
    updateWorkItem({
      itemId: current.item_id,
      status: 'ready',
      metadata: {
        ...(current.metadata || {}),
        ...(second.records[0]?.drift_watchdog || {}),
      },
    });

    const third = await dispatchMissionWorkItems(
      makeMissionState(),
      { mode: 'subagent', finalStatus: 'review' },
      { delegateTask }
    );

    expect(delegateTask).toHaveBeenCalledTimes(3);
    expect(first.records[0]?.work_item_status_after).toBe('review');
    expect(second.records[0]?.work_item_status_after).toBe('review');
    expect(third.records[0]).toMatchObject({
      work_item_status_after: 'blocked',
      drift_watchdog: expect.objectContaining({
        should_stop: true,
        needs_attention: true,
      }),
    });

    const items = listWorkItems({ projectId: missionId, source: 'local' });
    expect(items[0]).toMatchObject({ status: 'blocked' });

    const responseFile = `${missionPath}/evidence/workitem-dispatch-${third.records[0].item_id}.json`;
    const response = JSON.parse(safeReadFile(responseFile, { encoding: 'utf8' }) as string);
    expect(response.drift_watchdog_summary).toContain('attention=yes');
    expect(response.drift_watchdog_summary).toContain('stop=yes');
  });

  it('selects work items by linked project id when mission id differs from project id', async () => {
    const linkedMissionId = 'MSN-WORKITEM-LINKED-PROJECT-001';
    const linkedProjectId = 'PRJ-TEST-WEB';
    const linkedMissionPath = pathResolver.missionDir(linkedMissionId, 'public');
    if (!safeExistsSync(linkedMissionPath)) safeMkdir(linkedMissionPath, { recursive: true });

    // Seed the project-scoped artifact hint explicitly — relying on whatever
    // active/ happens to contain makes the assertion machine-local (green on
    // a dev box with history, red on a fresh CI checkout).
    appendArtifactOwnershipRecord(
      createArtifactOwnershipRecord({
        artifact_id: 'ART-LINKED-PROJECT-WEB',
        project_id: linkedProjectId,
        mission_id: 'MSN-LINKED-SEED',
        kind: 'markdown',
        storage_class: 'artifact_store',
        path: 'active/shared/artifacts/linked-project-web.md',
        created_at: '2026-06-05T00:00:00.000Z',
      })
    );

    safeWriteFile(
      `${linkedMissionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-1-linked-project',
            status: 'planned',
            assigned_to: { role: 'planner', agent_id: 'sovereign-brain' },
            description:
              'Verify linked project work item selection and ensure project-scoped artifact hints are still injected.',
            deliverable: 'evidence/linked-project-compatibility.md',
            target_path: 'evidence/linked-project-compatibility.md',
          },
        ],
        null,
        2
      )
    );

    createWorkItem({
      title: `${linkedMissionId}: Verify linked project dispatch`,
      description:
        'Verify linked project work item selection and ensure project-scoped artifact hints are still injected.',
      status: 'ready',
      source: 'local',
      sourceRef: `mission:${linkedMissionId}:task-1-linked-project`,
      projectId: linkedProjectId,
      assigneePeerId: 'sovereign-brain',
      labels: [`mission:${linkedMissionId}`, 'team_role:planner', 'ticket:workitem'],
      metadata: {
        mission_id: linkedMissionId,
        project_id: linkedProjectId,
        team_role: 'planner',
        deliverable: 'evidence/linked-project-compatibility.md',
        target_path: 'evidence/linked-project-compatibility.md',
        artifact_kind: 'markdown',
      },
    });

    const manifest = await dispatchMissionTickets(
      makeLinkedProjectMissionState({
        missionId: linkedMissionId,
        projectId: linkedProjectId,
        projectPath: `active/projects/public/shared/${linkedProjectId}/project-os`,
      }),
      {
        targets: ['workitem'],
      }
    );
    expect(manifest.records[0]?.work_item_id).toBeDefined();

    const dispatchManifest = await dispatchMissionWorkItems(
      makeLinkedProjectMissionState({
        missionId: linkedMissionId,
        projectId: linkedProjectId,
        projectPath: `active/projects/public/shared/${linkedProjectId}/project-os`,
      }),
      {
        mode: 'agent',
        finalStatus: 'review',
      },
      {
        routeA2A: vi.fn(async (envelope) => ({
          a2a_version: '1.0',
          header: {
            msg_id: 'RES-LINKED-1',
            sender: 'sovereign-brain',
            receiver: 'kyberion:workitem-dispatcher',
            performative: 'result' as const,
            timestamp: new Date().toISOString(),
          },
          payload: {
            text: makeTaskResultText({
              summary: 'Verified linked project dispatch and produced the requested artifact.',
              artifacts: [{ path: 'evidence/linked-project-compatibility.md', kind: 'markdown' }],
              verification_done: ['Confirmed the linked project dispatch path.'],
              gaps: [],
              needs: [],
              extraText: `${String(envelope.payload?.text || '')}\n\nlinked project dispatch confirmed`,
            }),
          },
        })),
      }
    );

    expect(dispatchManifest.work_item_count).toBe(1);
    expect(dispatchManifest.records[0]?.work_item_status_after).toBe('review');

    const responseFile = `${linkedMissionPath}/evidence/workitem-dispatch-${dispatchManifest.records[0].item_id}.json`;
    const response = JSON.parse(safeReadFile(responseFile, { encoding: 'utf8' }) as string);
    expect(response.prompt).toContain('Reusable artifact hints:');
    expect(response.prompt).toContain('PRJ-TEST-WEB');
    expect(response.response_text).toContain('linked project dispatch confirmed');

    safeRmSync(linkedMissionPath, { recursive: true, force: true });
  });

  it('reflects completed work item results back onto ticket artifacts', async () => {
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-1',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Implement the reflected ticket workflow',
            deliverable: 'evidence/ticket-reflection.md',
            target_path: 'evidence/ticket-reflection.md',
          },
        ],
        null,
        2
      )
    );

    await dispatchMissionTickets(makeMissionState(), {
      targets: ['workitem', 'github', 'jira'],
    });

    const manifest = await dispatchMissionWorkItems(
      makeMissionState(),
      {
        mode: 'subagent',
        finalStatus: 'done',
      },
      {
        delegateTask: vi.fn(async () =>
          makeTaskResultText({
            summary: 'Completed the reflected ticket workflow and wrote the requested artifact.',
            artifacts: [{ path: 'evidence/ticket-reflection.md', kind: 'markdown' }],
            verification_done: ['Confirmed ticket reflection updates were written.'],
            gaps: [],
            needs: [],
            extraText: 'subagent completed the reflected ticket workflow',
          })
        ),
      }
    );

    const replyPath = `${missionPath}/coordination/tickets/replies/task-1.json`;
    expect(safeExistsSync(replyPath)).toBe(true);
    const reply = JSON.parse(safeReadFile(replyPath, { encoding: 'utf8' }) as string);
    expect(reply).toMatchObject({
      mission_id: missionId,
      task_id: 'task-1',
      ticket_state: 'done',
    });
    expect(reply.context_pack_path).toContain('/coordination/context-packs/');

    const ticketManifest = JSON.parse(
      safeReadFile(`${missionPath}/coordination/tickets/dispatch-manifest.json`, {
        encoding: 'utf8',
      }) as string
    );
    expect(ticketManifest.records[0]).toMatchObject({
      task_id: 'task-1',
      reflection_status: 'done',
      ticket_state_after: 'done',
    });

    const nextTasks = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(nextTasks[0].ticket_dispatch).toMatchObject({
      result_status: 'done',
      review_required: false,
      blocked: false,
    });

    const githubArtifact = JSON.parse(
      safeReadFile(`${missionPath}/coordination/tickets/github/task-1.json`, {
        encoding: 'utf8',
      }) as string
    );
    expect(githubArtifact.state).toBe('closed');
    expect(Array.isArray(githubArtifact.comments)).toBe(true);
    expect(githubArtifact.comments.length).toBeGreaterThan(0);

    const jiraArtifact = JSON.parse(
      safeReadFile(`${missionPath}/coordination/tickets/jira/task-1.json`, {
        encoding: 'utf8',
      }) as string
    );
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

    const manifest = await dispatchMissionWorkItems(
      makeMissionState(),
      {
        mode: 'subagent',
        finalStatus: 'done',
      },
      {
        delegateTask: vi.fn(async () =>
          makeTaskResultText({
            summary: 'Completed the summary and captured the requested evidence.',
            artifacts: [{ path: 'evidence/summary.md', kind: 'markdown' }],
            verification_done: ['Reviewed the summary against the mission notes.'],
            gaps: [],
            needs: [],
            extraText: 'subagent completed the summary',
          })
        ),
      }
    );

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

    const manifest = await dispatchMissionWorkItems(
      makeMissionState(),
      {
        mode: 'subagent',
      },
      {
        delegateTask: vi.fn(async () =>
          makeTaskResultText({
            summary: 'Should not run.',
            artifacts: [],
            verification_done: [],
            gaps: [],
            needs: [],
            extraText: 'should not run',
          })
        ),
      }
    );

    expect(manifest.records[0]).toMatchObject({
      status: 'failed',
    });
    expect(manifest.records[0].notes).toContain('missing assignee_peer_id');
    expect(manifest.records[0].response_path).toBeUndefined();
    expect(
      safeExistsSync(
        `${missionPath}/evidence/workitem-dispatch-${manifest.records[0].item_id}.json`
      )
    ).toBe(false);
  });
});
