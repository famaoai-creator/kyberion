import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const route = vi.fn();
  const ensureMissionTeamRuntimeViaSupervisor = vi.fn();
  const shutdownAllAgentRuntimes = vi.fn();
  const resolveMissionTeamPlan = vi.fn();
  const loadMissionTeamPlan = vi.fn();
  const resolveMissionTeamReceiver = vi.fn();
  const buildMissionTeamView = vi.fn();
  const record = vi.fn();
  const emitMissionTaskEvent = vi.fn();

  return {
    route,
    ensureMissionTeamRuntimeViaSupervisor,
    shutdownAllAgentRuntimes,
    resolveMissionTeamPlan,
    loadMissionTeamPlan,
    resolveMissionTeamReceiver,
    buildMissionTeamView,
    record,
    emitMissionTaskEvent,
  };
});

function makeTaskResultText(input: {
  summary: string;
  artifacts?: Array<{ path: string; kind: string }>;
  verification_done?: string[];
  gaps?: string[];
  needs?: string[];
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
    }),
    '```',
    input.extraText || '',
  ]
    .filter(Boolean)
    .join('\n');
}

vi.mock('./a2a-bridge.js', () => ({
  a2aBridge: {
    route: mocks.route,
  },
}));

vi.mock('./agent-runtime-supervisor.js', () => ({
  ensureMissionTeamRuntimeViaSupervisor: mocks.ensureMissionTeamRuntimeViaSupervisor,
  shutdownAllAgentRuntimes: mocks.shutdownAllAgentRuntimes,
}));

vi.mock('./mission-team-plan-composer.js', () => ({
  resolveMissionTeamPlan: mocks.resolveMissionTeamPlan,
  loadMissionTeamPlan: mocks.loadMissionTeamPlan,
  resolveMissionTeamReceiver: mocks.resolveMissionTeamReceiver,
  buildMissionTeamView: mocks.buildMissionTeamView,
}));

vi.mock('./ledger.js', () => ({
  ledger: {
    record: mocks.record,
  },
}));

vi.mock('./mission-task-events.js', () => ({
  emitMissionTaskEvent: mocks.emitMissionTaskEvent,
}));

describe('mission-orchestration-worker', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    process.env.MISSION_ROLE = 'mission_controller';
    const { missionDir } = await import('./path-resolver.js');
    const { clearWorkCoordinationStore, setWorkCoordinationNamespace } =
      await import('./work-coordination.js');
    const { safeMkdir, safeWriteFile } = await import('./secure-io.js');
    setWorkCoordinationNamespace('mission-orchestration-worker-test');
    clearWorkCoordinationStore();
    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeMkdir(missionPath, { recursive: true });
    safeWriteFile(
      `${missionPath}/mission-state.json`,
      JSON.stringify(
        {
          mission_id: 'MSN-FOLLOWUP',
          mission_type: 'development',
          tier: 'public',
          status: 'active',
          execution_mode: 'local',
          relationships: {
            project: {
              project_id: 'MSN-FOLLOWUP',
              project_path: 'active/projects/public/shared/MSN-FOLLOWUP/project-os',
              relationship_type: 'supports',
              affected_artifacts: [],
              gate_impact: 'informational',
              traceability_refs: [],
              note: 'Mission worker fixture',
            },
          },
          priority: 3,
          assigned_persona: 'worker',
          confidence_score: 1,
          git: {
            branch: 'mission/worker-fixture',
            start_commit: 'abc123',
            latest_commit: 'abc123',
            checkpoints: [],
          },
          history: [],
        },
        null,
        2
      )
    );
    mocks.resolveMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-FOLLOWUP',
      mission_type: 'development',
      assignments: [],
    });
    mocks.buildMissionTeamView.mockReturnValue({ planner: 'nerve-agent' });
    mocks.resolveMissionTeamReceiver.mockReturnValue({
      agent_id: 'implementation-architect',
      model_hint: {
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
        route_reason: 'phase_kind=mechanical -> small/low',
      },
    });
  });

  afterEach(async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { clearWorkCoordinationStore, clearWorkCoordinationNamespace } =
      await import('./work-coordination.js');
    const { safeExistsSync, safeRmSync } = await import('./secure-io.js');
    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    if (safeExistsSync(missionPath)) safeRmSync(missionPath);
    clearWorkCoordinationStore();
    clearWorkCoordinationNamespace();
  });

  it('does not install reasoning backends during import', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await import('./mission-orchestration-worker.js');
      expect(errorSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('dispatches planned next tasks and marks them requested', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile, safeReadFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-1',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Implement the deck',
            deliverable: 'deliverables/presentation.html',
          },
          {
            task_id: 'task-2',
            status: 'planned',
            assigned_to: { role: 'reviewer', agent_id: 'implementation-architect' },
            description: 'Review the deck',
            deliverable: 'Reviewed deliverables',
          },
        ],
        null,
        2
      )
    );
    safeWriteFile(
      `${missionPath}/TASK_BOARD.md`,
      [
        '# TASK_BOARD: MSN-FOLLOWUP',
        '',
        '## Status: Planning Ready',
        '',
        '### 🛠️ Execution Phase',
        '- [x] Step 1: Research and Strategy',
        '- [ ] Step 2: Implementation',
        '- [ ] Step 3: Validation',
        '',
      ].join('\n')
    );

    mocks.ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue({
      runtime_plan: {
        mission_id: 'MSN-FOLLOWUP',
        assignments: [],
      },
    });
    mocks.resolveMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-FOLLOWUP',
      mission_type: 'product_development',
      assignments: [],
    });
    mocks.buildMissionTeamView.mockReturnValue({ planner: 'nerve-agent' });
    mocks.resolveMissionTeamReceiver
      .mockReturnValueOnce({
        agent_id: 'implementation-architect',
        model_hint: {
          tier: 'small',
          effort: 'low',
          model_id: 'openai:gpt-5.4-mini',
          route_reason: 'phase_kind=mechanical -> small/low',
        },
      })
      .mockReturnValueOnce({
        agent_id: 'implementation-architect',
        model_hint: {
          tier: 'small',
          effort: 'low',
          model_id: 'openai:gpt-5.4-mini',
          route_reason: 'phase_kind=mechanical -> small/low',
        },
      });
    mocks.route.mockResolvedValue({
      payload: {
        text: makeTaskResultText({
          summary: 'Accepted the task and recorded the requested artifact.',
          artifacts: [{ path: 'deliverables/presentation.html', kind: 'html' }],
          verification_done: ['Confirmed the deliverable path.'],
          gaps: [],
          needs: [],
          extraText: 'accepted',
        }),
      },
    });

    const dispatched = await dispatchMissionNextTasks('MSN-FOLLOWUP');

    expect(mocks.ensureMissionTeamRuntimeViaSupervisor).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'MSN-FOLLOWUP',
        teamRoles: ['implementer', 'reviewer'],
      })
    );
    expect(mocks.route).toHaveBeenCalledTimes(2);
    expect(mocks.route.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        context: {
          task_model_hint: expect.objectContaining({
            model_id: 'openai:gpt-5.4-mini',
            tier: 'small',
            effort: 'low',
            route_reason: 'phase_kind=mechanical -> small/low',
          }),
        },
      },
    });
    const prompt = String((mocks.route.mock.calls[0]?.[0] as any)?.payload?.text || '');
    expect(prompt).toContain('Mission context pack (scoped, minimal, role-specific).');
    expect(prompt).toContain('Return exactly one ```task_result``` block');
    expect(dispatched).toEqual([
      { task_id: 'task-1', team_role: 'implementer', agent_id: 'implementation-architect' },
      { task_id: 'task-2', team_role: 'reviewer', agent_id: 'implementation-architect' },
    ]);

    const stored = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(stored.map((task: any) => task.status)).toEqual(['requested', 'requested']);

    const taskBoard = safeReadFile(`${missionPath}/TASK_BOARD.md`, { encoding: 'utf8' }) as string;
    expect(taskBoard).toContain('## Status: Execution Ready');
    expect(taskBoard).toContain('- [~] Step 2: Implementation');
    expect(mocks.record).toHaveBeenCalledWith(
      'MISSION_FOLLOWUP_DISPATCHED',
      expect.objectContaining({
        mission_id: 'MSN-FOLLOWUP',
        dispatched_task_count: 2,
        average_context_chars: expect.any(Number),
        needs_rate: 0,
        result_schema_ok_rate: 1,
      })
    );
  });

  it('dispatches dependency-ready tasks in task_id order up to the parallel cap', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile, safeReadFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-b',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Implement the later task',
            deliverable: 'deliverables/task-b.md',
          },
          {
            task_id: 'task-a',
            status: 'planned',
            assigned_to: { role: 'reviewer', agent_id: 'implementation-architect' },
            description: 'Implement the earlier task',
            deliverable: 'deliverables/task-a.md',
          },
        ],
        null,
        2
      )
    );
    safeWriteFile(
      `${missionPath}/TASK_BOARD.md`,
      [
        '# TASK_BOARD: MSN-FOLLOWUP',
        '',
        '## Status: Planning Ready',
        '',
        '### 🛠️ Execution Phase',
        '- [x] Step 1: Research and Strategy',
        '- [ ] Step 2: Implementation',
        '- [ ] Step 3: Validation',
        '',
      ].join('\n')
    );

    mocks.ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue({
      runtime_plan: { mission_id: 'MSN-FOLLOWUP', assignments: [] },
    });
    mocks.resolveMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-FOLLOWUP',
      mission_type: 'product_development',
      team_governance: {
        lifecycle: {
          max_parallel_members: 2,
        },
      },
      assignments: [],
    });
    mocks.buildMissionTeamView.mockReturnValue({ planner: 'nerve-agent' });
    mocks.resolveMissionTeamReceiver.mockReturnValue({
      agent_id: 'implementation-architect',
      model_hint: {
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
        route_reason: 'phase_kind=mechanical -> small/low',
      },
    });

    const pendingResponses: Array<{ resolve: (value: any) => void }> = [];
    mocks.route.mockImplementation(
      () =>
        new Promise((resolve) => {
          pendingResponses.push({ resolve });
        })
    );

    const dispatchedPromise = dispatchMissionNextTasks('MSN-FOLLOWUP');
    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.route).toHaveBeenCalledTimes(2);
    expect(
      mocks.route.mock.calls.map((call) =>
        String((call[0] as any)?.payload?.context?.task_id || '')
      )
    ).toEqual(['task-a', 'task-b']);

    pendingResponses[0]?.resolve({
      payload: {
        text: makeTaskResultText({
          summary: 'Accepted task-a.',
          artifacts: [{ path: 'deliverables/task-a.md', kind: 'markdown' }],
          verification_done: ['Completed task-a.'],
          gaps: [],
          needs: [],
        }),
      },
    });
    pendingResponses[1]?.resolve({
      payload: {
        text: makeTaskResultText({
          summary: 'Accepted task-b.',
          artifacts: [{ path: 'deliverables/task-b.md', kind: 'markdown' }],
          verification_done: ['Completed task-b.'],
          gaps: [],
          needs: [],
        }),
      },
    });

    const dispatched = await dispatchedPromise;
    const stored = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );

    expect(dispatched).toEqual([
      { task_id: 'task-a', team_role: 'reviewer', agent_id: 'implementation-architect' },
      { task_id: 'task-b', team_role: 'implementer', agent_id: 'implementation-architect' },
    ]);
    expect(stored.map((task: any) => task.status)).toEqual(['requested', 'requested']);
  });

  it('creates and claims a work item for each dispatched mission task', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
    const { listWorkItems, listWorkItemAttempts, listActiveWorkLeases } =
      await import('./work-coordination.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-work-item',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Track the work item lifecycle',
            deliverable: 'deliverables/work-item.md',
          },
        ],
        null,
        2
      )
    );
    safeWriteFile(
      `${missionPath}/TASK_BOARD.md`,
      [
        '# TASK_BOARD: MSN-FOLLOWUP',
        '',
        '## Status: Planning Ready',
        '',
        '### 🛠️ Execution Phase',
        '- [x] Step 1: Research and Strategy',
        '- [ ] Step 2: Implementation',
        '- [ ] Step 3: Validation',
        '',
      ].join('\n')
    );

    mocks.ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue({
      runtime_plan: { mission_id: 'MSN-FOLLOWUP', assignments: [] },
    });
    mocks.resolveMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-FOLLOWUP',
      mission_type: 'product_development',
      assignments: [],
    });
    mocks.buildMissionTeamView.mockReturnValue({ planner: 'nerve-agent' });
    mocks.resolveMissionTeamReceiver.mockReturnValue({
      agent_id: 'implementation-architect',
      model_hint: {
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
        route_reason: 'phase_kind=mechanical -> small/low',
      },
    });
    mocks.route.mockResolvedValue({
      payload: {
        text: makeTaskResultText({
          summary: 'Accepted the tracked work item.',
          artifacts: [{ path: 'deliverables/work-item.md', kind: 'markdown' }],
          verification_done: ['Work item claimed.'],
          gaps: [],
          needs: [],
        }),
      },
    });

    await dispatchMissionNextTasks('MSN-FOLLOWUP');

    const workItems = listWorkItems({ source: 'local' });
    expect(workItems).toHaveLength(1);
    expect(workItems[0]).toMatchObject({
      source_ref: 'mission:MSN-FOLLOWUP:task-work-item',
      project_id: 'MSN-FOLLOWUP',
      status: 'done',
    });
    expect(listWorkItemAttempts(workItems[0].item_id)).toHaveLength(1);
    expect(listWorkItemAttempts(workItems[0].item_id)[0]).toMatchObject({
      status: 'completed',
      actor_peer_id: 'mission-orchestration-worker',
    });
    expect(
      listActiveWorkLeases().filter((lease: any) => lease.item_id === workItems[0].item_id)
    ).toHaveLength(0);
  });

  it('re-prompts once when the initial task result is unstructured', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile, safeReadFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-retry',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Return a structured task result',
            deliverable: 'deliverables/task-result.md',
          },
        ],
        null,
        2
      )
    );
    safeWriteFile(
      `${missionPath}/TASK_BOARD.md`,
      [
        '# TASK_BOARD: MSN-FOLLOWUP',
        '',
        '## Status: Planning Ready',
        '',
        '### 🛠️ Execution Phase',
        '- [x] Step 1: Research and Strategy',
        '- [ ] Step 2: Implementation',
        '- [ ] Step 3: Validation',
        '',
      ].join('\n')
    );

    mocks.ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue({
      runtime_plan: { mission_id: 'MSN-FOLLOWUP', assignments: [] },
    });
    mocks.resolveMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-FOLLOWUP',
      mission_type: 'product_development',
      assignments: [],
    });
    mocks.buildMissionTeamView.mockReturnValue({ planner: 'nerve-agent' });
    mocks.resolveMissionTeamReceiver.mockReturnValue({
      agent_id: 'implementation-architect',
      model_hint: {
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
        route_reason: 'phase_kind=mechanical -> small/low',
      },
    });
    mocks.route
      .mockResolvedValueOnce({ payload: { text: 'plain response' } })
      .mockResolvedValueOnce({
        payload: {
          text: makeTaskResultText({
            summary: 'Returned the structured task result after retry.',
            artifacts: [{ path: 'deliverables/task-result.md', kind: 'markdown' }],
            verification_done: ['Resent the response in the required format.'],
            gaps: [],
            needs: [],
          }),
        },
      });

    const dispatched = await dispatchMissionNextTasks('MSN-FOLLOWUP');

    expect(mocks.route).toHaveBeenCalledTimes(2);
    expect(dispatched).toEqual([
      { task_id: 'task-retry', team_role: 'implementer', agent_id: 'implementation-architect' },
    ]);
    const stored = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(stored[0].status).toBe('requested');
  });

  it('blocks and writes a clarification packet when task_result needs remain', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile, safeExistsSync, safeReadFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-needs',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Clarify missing inputs',
            deliverable: 'deliverables/task-needs.md',
          },
        ],
        null,
        2
      )
    );
    safeWriteFile(
      `${missionPath}/TASK_BOARD.md`,
      [
        '# TASK_BOARD: MSN-FOLLOWUP',
        '',
        '## Status: Planning Ready',
        '',
        '### 🛠️ Execution Phase',
        '- [x] Step 1: Research and Strategy',
        '- [ ] Step 2: Implementation',
        '- [ ] Step 3: Validation',
        '',
      ].join('\n')
    );

    mocks.ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue({
      runtime_plan: { mission_id: 'MSN-FOLLOWUP', assignments: [] },
    });
    mocks.resolveMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-FOLLOWUP',
      mission_type: 'product_development',
      assignments: [],
    });
    mocks.buildMissionTeamView.mockReturnValue({ planner: 'nerve-agent' });
    mocks.resolveMissionTeamReceiver.mockReturnValue({
      agent_id: 'implementation-architect',
      model_hint: {
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
        route_reason: 'phase_kind=mechanical -> small/low',
      },
    });
    mocks.route.mockResolvedValue({
      payload: {
        text: makeTaskResultText({
          summary: 'The task is blocked by missing input.',
          artifacts: [],
          verification_done: ['Recorded the blocker.'],
          gaps: ['Input is missing.'],
          needs: ['project_brief'],
        }),
      },
    });

    const dispatched = await dispatchMissionNextTasks('MSN-FOLLOWUP');

    expect(dispatched).toEqual([]);
    const stored = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(stored[0].status).toBe('blocked');

    const clarificationPath = `${missionPath}/evidence/task-clarification-task-needs.json`;
    expect(safeExistsSync(clarificationPath)).toBe(true);
    const clarification = JSON.parse(
      safeReadFile(clarificationPath, { encoding: 'utf8' }) as string
    );
    expect(clarification.status).toBe('needs_input');
    expect(clarification.clarification_packet.kind).toBe('operator-interaction-packet');
  });

  it('reconciles accepted task outcomes into the task board and ledger', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile, safeReadFile } = await import('./secure-io.js');
    const { reconcileMissionProgress } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-1',
            status: 'accepted',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Implement the deck',
            deliverable: 'deliverables/presentation.html',
          },
        ],
        null,
        2
      )
    );
    safeWriteFile(
      `${missionPath}/TASK_BOARD.md`,
      [
        '# TASK_BOARD: MSN-FOLLOWUP',
        '',
        '## Status: Execution Ready',
        '',
        '### 🛠️ Execution Phase',
        '- [x] Step 1: Research and Strategy',
        '- [~] Step 2: Implementation',
        '- [ ] Step 3: Validation',
        '',
      ].join('\n')
    );

    reconcileMissionProgress('MSN-FOLLOWUP');

    const taskBoard = safeReadFile(`${missionPath}/TASK_BOARD.md`, { encoding: 'utf8' }) as string;
    expect(taskBoard).toContain('## Status: Review Accepted');
    expect(taskBoard).toContain('- [x] Step 2: Implementation');
    expect(taskBoard).toContain('- [x] Step 3: Validation');
    expect(mocks.record).toHaveBeenCalledWith(
      'MISSION_TASK_OUTCOMES_RECONCILED',
      expect.objectContaining({
        mission_id: 'MSN-FOLLOWUP',
        accepted_count: 1,
      })
    );
  });

  it('persists planner packets into PLAN.md and NEXT_TASKS.json', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeReadFile } = await import('./secure-io.js');
    const { persistPlanningPacket } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    persistPlanningPacket('MSN-FOLLOWUP', {
      mission_id: 'MSN-FOLLOWUP',
      summary: 'Collect active mission state',
      plan_markdown: '# PLAN\n\n## Objective\nCollect active mission state\n',
      next_tasks: [
        {
          task_id: 'task-1',
          team_role: 'operator',
          description: 'Collect current mission registry',
          deliverable: 'artifacts/current-missions.md',
        },
      ],
    });

    const plan = safeReadFile(`${missionPath}/PLAN.md`, { encoding: 'utf8' }) as string;
    const nextTasks = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );

    expect(plan).toContain('# PLAN');
    expect(nextTasks).toEqual([
      expect.objectContaining({
        task_id: 'task-1',
        status: 'planned',
        assigned_to: { role: 'operator' },
        description: 'Collect current mission registry',
        deliverable: 'artifacts/current-missions.md',
        dependencies: [],
        acceptance_criteria: ['Collect current mission registry'],
        risk: 'medium',
        expected_output_format: 'files',
        estimated_scope: 'M',
      }),
    ]);
  });

  it('re-prompts the planner once when the initial planning packet fails validation', async () => {
    const { resolveMissionPlanningPacket } = await import('./mission-orchestration-worker.js');

    mocks.resolveMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-FOLLOWUP',
      mission_type: 'product_development',
      assignments: [],
    });
    mocks.buildMissionTeamView.mockReturnValue({ planner: 'nerve-agent' });
    mocks.route
      .mockResolvedValueOnce({
        payload: {
          text: [
            '```planning_packet',
            JSON.stringify({
              plan_markdown: '',
              next_tasks: [],
            }),
            '```',
          ].join('\n'),
        },
      })
      .mockResolvedValueOnce({
        payload: {
          text: [
            '```planning_packet',
            JSON.stringify({
              mission_id: 'MSN-FOLLOWUP',
              summary: 'Collect active mission state',
              plan_markdown: '# PLAN\n\n## Objective\nCollect active mission state\n',
              next_tasks: [
                {
                  task_id: 'task-1',
                  team_role: 'operator',
                  description: 'Collect current mission registry',
                  deliverable: 'artifacts/current-missions.md',
                },
              ],
            }),
            '```',
          ].join('\n'),
        },
      });

    const packet = await resolveMissionPlanningPacket(
      'MSN-FOLLOWUP',
      { mission_id: 'MSN-FOLLOWUP', mission_type: 'product_development' },
      { channel: 'C123', threadTs: '123.456', sourceText: 'Please plan this' },
      'planner-agent',
      { planner: 'nerve-agent' }
    );

    expect(mocks.route).toHaveBeenCalledTimes(2);
    expect(packet.plan_markdown).toContain('# PLAN');
    expect(packet.next_tasks).toHaveLength(1);
  });

  it('routes high-risk planning packets through an independent reviewer and re-plans once on rejection', async () => {
    const { resolveMissionPlanningPacket } = await import('./mission-orchestration-worker.js');

    mocks.resolveMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-FOLLOWUP',
      mission_type: 'product_development',
      assignments: [],
    });
    mocks.buildMissionTeamView.mockReturnValue({
      planner: 'nerve-agent',
      reviewer: 'review-agent',
    });
    mocks.resolveMissionTeamReceiver.mockReturnValue({ agent_id: 'review-agent' });
    mocks.route.mockImplementation(async (envelope: any) => {
      const text = String(envelope.payload?.text || '');
      if (text.includes('Review the planning packet')) {
        if (text.includes('Planner revision guidance')) {
          return {
            payload: {
              text: JSON.stringify({
                approve: true,
                gaps: [],
                rationale: 'The revised plan now includes the required reviewer sign-off path.',
              }),
            },
          };
        }
        return {
          payload: {
            text: JSON.stringify({
              approve: false,
              gaps: ['Add an independent reviewer step for the high-stakes task.'],
              rationale: 'High-risk work needs a separate reviewer context before execution.',
            }),
          },
        };
      }
      if (text.includes('Contract violations:')) {
        return {
          payload: {
            text: [
              '```planning_packet',
              JSON.stringify({
                mission_id: 'MSN-FOLLOWUP',
                summary: 'Collect active mission state',
                plan_markdown: '# PLAN\n\n## Objective\nCollect active mission state\n',
                next_tasks: [
                  {
                    task_id: 'task-1',
                    team_role: 'operator',
                    description: 'Collect current mission registry',
                    deliverable: 'artifacts/current-missions.md',
                    risk: 'high_stakes',
                    dependencies: ['task-bootstrap'],
                    acceptance_criteria: [
                      'Collect current mission state',
                      'Include a reviewer step',
                    ],
                  },
                ],
              }),
              '```',
            ].join('\n'),
          },
        };
      }
      return {
        payload: {
          text: [
            '```planning_packet',
            JSON.stringify({
              mission_id: 'MSN-FOLLOWUP',
              summary: 'Collect active mission state',
              plan_markdown: '# PLAN\n\n## Objective\nCollect active mission state\n',
              next_tasks: [
                {
                  task_id: 'task-1',
                  team_role: 'operator',
                  description: 'Collect current mission registry',
                  deliverable: 'artifacts/current-missions.md',
                  risk: 'high_stakes',
                },
              ],
            }),
            '```',
          ].join('\n'),
        },
      };
    });

    const packet = await resolveMissionPlanningPacket(
      'MSN-FOLLOWUP',
      { mission_id: 'MSN-FOLLOWUP', mission_type: 'product_development' },
      { channel: 'C123', threadTs: '123.456', sourceText: 'Please plan this high-risk work' },
      'planner-agent',
      { planner: 'nerve-agent', reviewer: 'review-agent' }
    );

    expect(mocks.route).toHaveBeenCalledTimes(4);
    expect(packet.next_tasks[0]?.risk).toBe('high_stakes');
    expect(packet.next_tasks[0]?.dependencies).toEqual(['task-bootstrap']);
    expect(packet.next_tasks[0]?.acceptance_criteria).toContain('Include a reviewer step');

    const reviewPrompts = mocks.route.mock.calls
      .map((call) => String((call[0] as any)?.payload?.text || ''))
      .filter((text) => text.includes('Review the planning packet'));
    expect(reviewPrompts[1]).toContain('Planner revision guidance');
    expect(reviewPrompts[1]).toContain(
      'Add an independent reviewer step for the high-stakes task.'
    );
  });

  it('blocks delegated tasks when preflight path policy fails', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile, safeReadFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-blocked',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Attempt disallowed write',
            target_path: 'knowledge/product/architecture/disallowed.md',
            deliverable: 'knowledge/product/architecture/disallowed.md',
          },
        ],
        null,
        2
      )
    );
    safeWriteFile(
      `${missionPath}/TASK_BOARD.md`,
      [
        '# TASK_BOARD: MSN-FOLLOWUP',
        '',
        '## Status: Planning Ready',
        '',
        '### 🛠️ Execution Phase',
        '- [x] Step 1: Research and Strategy',
        '- [ ] Step 2: Implementation',
        '- [ ] Step 3: Validation',
        '',
      ].join('\n')
    );

    mocks.ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue({
      runtime_plan: {
        mission_id: 'MSN-FOLLOWUP',
        assignments: [],
      },
    });
    mocks.resolveMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-FOLLOWUP',
      mission_type: 'product_development',
      assignments: [],
    });
    mocks.buildMissionTeamView.mockReturnValue({ planner: 'nerve-agent' });
    mocks.resolveMissionTeamReceiver.mockReturnValue({
      agent_id: 'implementation-architect',
      authority_role: 'ecosystem_architect',
      delegation_contract: {
        ownership_scope: 'bounded implementation',
        allowed_delegate_team_roles: [],
        escalation_parent_team_role: 'planner',
        required_scope_classes: ['codebase_core'],
        resolved_scope_classes: ['codebase_core'],
        allowed_write_scopes: ['libs/core/', 'scripts/'],
      },
    });

    const dispatched = await dispatchMissionNextTasks('MSN-FOLLOWUP');

    expect(dispatched).toEqual([]);
    expect(mocks.route).not.toHaveBeenCalled();

    const stored = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(stored[0]?.status).toBe('blocked');
  });

  it('blocks tasks with no assigned role instead of skipping them', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile, safeReadFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-unassigned',
            status: 'planned',
            description: 'Handle the missing role',
            deliverable: 'deliverables/missing-role.md',
          },
        ],
        null,
        2
      )
    );
    safeWriteFile(
      `${missionPath}/TASK_BOARD.md`,
      [
        '# TASK_BOARD: MSN-FOLLOWUP',
        '',
        '## Status: Planning Ready',
        '',
        '### 🛠️ Execution Phase',
        '- [x] Step 1: Research and Strategy',
        '- [ ] Step 2: Implementation',
        '- [ ] Step 3: Validation',
        '',
      ].join('\n')
    );

    const dispatched = await dispatchMissionNextTasks('MSN-FOLLOWUP');
    const stored = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );

    expect(dispatched).toEqual([]);
    expect(stored[0]?.status).toBe('blocked');
    expect(mocks.route).not.toHaveBeenCalled();
    expect(mocks.emitMissionTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          summary: 'Task task-unassigned is blocked because role unassigned is not assigned.',
        }),
      })
    );
  });

  it('defers tasks until dependency tasks are completed', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile, safeReadFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-bootstrap',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Set up the prerequisite',
            deliverable: 'deliverables/bootstrap.md',
          },
          {
            task_id: 'task-followup',
            status: 'planned',
            assigned_to: { role: 'reviewer', agent_id: 'implementation-architect' },
            description: 'Use the prerequisite output',
            dependencies: ['task-bootstrap'],
            deliverable: 'deliverables/followup.md',
          },
        ],
        null,
        2
      )
    );
    safeWriteFile(
      `${missionPath}/TASK_BOARD.md`,
      [
        '# TASK_BOARD: MSN-FOLLOWUP',
        '',
        '## Status: Planning Ready',
        '',
        '### 🛠️ Execution Phase',
        '- [x] Step 1: Research and Strategy',
        '- [ ] Step 2: Implementation',
        '- [ ] Step 3: Validation',
        '',
      ].join('\n')
    );

    mocks.ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue({
      runtime_plan: {
        mission_id: 'MSN-FOLLOWUP',
        assignments: [],
      },
    });
    mocks.resolveMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-FOLLOWUP',
      mission_type: 'product_development',
      assignments: [],
    });
    mocks.buildMissionTeamView.mockReturnValue({ planner: 'nerve-agent' });
    mocks.resolveMissionTeamReceiver.mockReturnValue({
      agent_id: 'implementation-architect',
      model_hint: {
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
        route_reason: 'phase_kind=mechanical -> small/low',
      },
    });
    mocks.route.mockResolvedValue({
      payload: {
        text: makeTaskResultText({
          summary: 'Completed the prerequisite task.',
          artifacts: [{ path: 'deliverables/bootstrap.md', kind: 'markdown' }],
          verification_done: ['Confirmed the prerequisite output.'],
          gaps: [],
          needs: [],
        }),
      },
    });

    const dispatched = await dispatchMissionNextTasks('MSN-FOLLOWUP');
    const stored = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );

    expect(dispatched).toEqual([
      { task_id: 'task-bootstrap', team_role: 'implementer', agent_id: 'implementation-architect' },
    ]);
    expect(mocks.route).toHaveBeenCalledTimes(1);
    expect(stored.map((task: any) => task.status)).toEqual(['requested', 'planned']);
  });

  it('renders gate status and rework count into the task board', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeMkdir, safeWriteFile, safeReadFile } = await import('./secure-io.js');
    const { reconcileMissionProgress } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeMkdir(`${missionPath}/gates`, { recursive: true });
    safeWriteFile(
      `${missionPath}/mission-state.json`,
      JSON.stringify(
        {
          mission_id: 'MSN-FOLLOWUP',
          tier: 'public',
          status: 'active',
          execution_mode: 'local',
          priority: 1,
          assigned_persona: 'tester',
          confidence_score: 1,
          git: {
            branch: 'main',
            start_commit: 'abc123',
            latest_commit: 'abc123',
            checkpoints: [],
          },
          context: {
            mission_finish_gate_failure_count: 2,
          },
          history: [],
        },
        null,
        2
      )
    );
    safeWriteFile(
      `${missionPath}/gates/finish-exit-1.json`,
      JSON.stringify(
        {
          gate_id: 'finish-exit',
          verdict: 'fail',
          reason: 'Pending tasks remain: task-1',
          failure_count: 2,
          should_realign: true,
        },
        null,
        2
      )
    );
    safeWriteFile(
      `${missionPath}/TASK_BOARD.md`,
      [
        '# TASK_BOARD: MSN-FOLLOWUP',
        '',
        '## Status: Execution Ready',
        '',
        '### 🛠️ Execution Phase',
        '- [x] Step 1: Research and Strategy',
        '- [~] Step 2: Implementation',
        '- [ ] Step 3: Validation',
        '',
      ].join('\n')
    );
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-1',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Complete the remaining gate work',
            deliverable: 'evidence/gate-work.md',
          },
        ],
        null,
        2
      )
    );

    reconcileMissionProgress('MSN-FOLLOWUP');

    const taskBoard = safeReadFile(`${missionPath}/TASK_BOARD.md`, { encoding: 'utf8' }) as string;
    expect(taskBoard).toContain('### Gate Status');
    expect(taskBoard).toContain('Rework count: 2');
    expect(taskBoard).toContain('finish-exit');
  });
});
