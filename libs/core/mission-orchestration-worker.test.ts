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

vi.mock('./a2a-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./a2a-bridge.js')>();
  return {
    ...actual,
    a2aBridge: {
      ...actual.a2aBridge,
      route: mocks.route,
    },
  };
});

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

// Full dispatch flows through real module wiring — comfortably fast locally
// but regularly past the 10s default on shared CI runners.
describe('mission-orchestration-worker', { timeout: 60_000 }, () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    process.env.MISSION_ROLE = 'mission_controller';
    const { missionDir, pathResolver } = await import('./path-resolver.js');
    // Shared observability streams are gated off under vitest; suites that
    // assert on them opt into a redirect under the governed tmp root.
    process.env.KYBERION_TEST_OBSERVABILITY_DIR = pathResolver.shared(
      `tmp/vitest-observability/mission-orchestration-worker-${process.pid}`
    );
    const { clearWorkCoordinationStore, setWorkCoordinationNamespace } =
      await import('./work-coordination.js');
    const { safeMkdir, safeWriteFile } = await import('./secure-io.js');
    setWorkCoordinationNamespace('mission-orchestration-worker-test');
    clearWorkCoordinationStore();
    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeMkdir(missionPath, { recursive: true });
    safeMkdir(`${missionPath}/deliverables`, { recursive: true });
    safeWriteFile(`${missionPath}/deliverables/presentation.html`, '<html>presentation</html>');
    safeWriteFile(`${missionPath}/deliverables/work-item.md`, '# work item');
    safeWriteFile(`${missionPath}/deliverables/bootstrap.md`, '# bootstrap');
    safeWriteFile(`${missionPath}/deliverables/task-result.md`, '# task result');
    safeWriteFile(`${missionPath}/deliverables/task-a.md`, '# task a');
    safeWriteFile(`${missionPath}/deliverables/task-b.md`, '# task b');
    safeWriteFile(`${missionPath}/deliverables/followup.md`, '# followup');
    safeWriteFile(`${missionPath}/deliverables/REVIEW-task-1.md`, '# review task 1');
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
    mocks.resolveMissionTeamReceiver.mockImplementation(({ teamRole }: { teamRole: string }) => ({
      agent_id: teamRole === 'reviewer' ? 'independent-reviewer' : 'implementation-architect',
      model_hint: {
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
        route_reason: 'phase_kind=mechanical -> small/low',
      },
    }));
  });

  afterEach(async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { clearWorkCoordinationStore, clearWorkCoordinationNamespace } =
      await import('./work-coordination.js');
    const { safeExistsSync, safeRmSync } = await import('./secure-io.js');
    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    if (safeExistsSync(missionPath)) safeRmSync(missionPath);
    const observabilityDir = process.env.KYBERION_TEST_OBSERVABILITY_DIR;
    if (observabilityDir && safeExistsSync(observabilityDir)) safeRmSync(observabilityDir);
    delete process.env.KYBERION_TEST_OBSERVABILITY_DIR;
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

  it('dispatches planned next tasks and marks them completed after acceptance', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile, safeReadFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(`${missionPath}/deliverables/REVIEW-task-bootstrap.md`, '# review followup');
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
            assigned_to: { role: 'reviewer', agent_id: 'independent-reviewer' },
            description: 'Review the deck',
            deliverable: 'deliverables/REVIEW-task-1.md',
            dependencies: ['task-1'],
            review_target: 'task-1',
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
        agent_id: 'independent-reviewer',
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
      { task_id: 'task-2', team_role: 'reviewer', agent_id: 'independent-reviewer' },
    ]);

    const stored = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(stored.map((task: any) => task.status)).toEqual(['completed', 'completed']);

    const taskBoard = safeReadFile(`${missionPath}/TASK_BOARD.md`, { encoding: 'utf8' }) as string;
    expect(taskBoard).toContain('## Status: Validation Ready');
    expect(taskBoard).toContain('- [x] Step 2: Implementation');
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

  it('blocks a self-review assignment without reopening the completed implementation', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeReadFile, safeWriteFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-implementation',
            status: 'completed',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Implement the artifact',
            deliverable: 'deliverables/task-a.md',
          },
          {
            task_id: 'task-review',
            status: 'planned',
            assigned_to: { role: 'reviewer', agent_id: 'implementation-architect' },
            description: 'Review the artifact',
            deliverable: 'deliverables/REVIEW-task-implementation.md',
            dependencies: ['task-implementation'],
            review_target: 'task-implementation',
          },
        ],
        null,
        2
      )
    );
    mocks.resolveMissionTeamReceiver.mockReturnValue({
      agent_id: 'implementation-architect',
      model_hint: {
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
        route_reason: 'phase_kind=review -> small/low',
      },
    });

    const dispatched = await dispatchMissionNextTasks('MSN-FOLLOWUP');

    const tasks = JSON.parse(
      String(safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }))
    ) as Array<{ task_id: string; status: string; rework_packet?: unknown }>;
    expect(dispatched).toEqual([]);
    expect(mocks.route).not.toHaveBeenCalled();
    expect(tasks.find((task) => task.task_id === 'task-implementation')).toMatchObject({
      status: 'completed',
    });
    expect(
      tasks.find((task) => task.task_id === 'task-implementation')?.rework_packet
    ).toBeUndefined();
    expect(tasks.find((task) => task.task_id === 'task-review')).toMatchObject({
      status: 'blocked',
    });
    expect(mocks.emitMissionTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: 'task-review',
        policy_used: 'artifact_review_independence_v1',
        payload: expect.objectContaining({ reason: 'blocked(reviewer_independence)' }),
      })
    );
  });

  it('reviews a reconciled implementation artifact and preserves its reconciliation evidence', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeReadFile, safeWriteFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(
      `${missionPath}/deliverables/REVIEW-task-implementation.md`,
      '# reconciled implementation review'
    );
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-implementation',
            status: 'completed',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Implement the artifact',
            deliverable: 'deliverables/task-a.md',
            reconciliation: {
              manifest_sha256: 'a'.repeat(64),
              evidence: [
                {
                  path: 'libs/core/artifact-review.ts',
                  sha256: 'b'.repeat(64),
                  kind: 'artifact',
                },
              ],
            },
          },
          {
            task_id: 'task-review',
            status: 'planned',
            assigned_to: { role: 'reviewer', agent_id: 'independent-reviewer' },
            description: 'Review the reconciled artifact',
            deliverable: 'deliverables/REVIEW-task-implementation.md',
            dependencies: ['task-implementation'],
            review_target: 'task-implementation',
            acceptance_criteria: ['The reconciled artifact has no blocking defects.'],
          },
        ],
        null,
        2
      )
    );
    mocks.resolveMissionTeamReceiver.mockReturnValue({
      agent_id: 'independent-reviewer',
      model_hint: {
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
        route_reason: 'phase_kind=review -> small/low',
      },
    });
    mocks.route.mockResolvedValue({
      payload: {
        text: makeTaskResultText({
          summary: 'The reconciled implementation passes review.',
          artifacts: [{ path: 'deliverables/REVIEW-task-implementation.md', kind: 'markdown' }],
          verification_done: [
            'Reviewed the commit-bound implementation artifact.',
            'The reconciled artifact has no blocking defects.',
          ],
          gaps: [],
          needs: [],
        }),
      },
    });

    const dispatched = await dispatchMissionNextTasks('MSN-FOLLOWUP');

    const prompt = String(mocks.route.mock.calls[0]?.[0]?.payload?.text || '');
    const tasks = JSON.parse(
      String(safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }))
    ) as Array<{
      task_id: string;
      status: string;
      reconciliation?: { evidence?: Array<{ path: string }> };
      artifact_review_receipt?: string;
    }>;
    expect(dispatched).toEqual([
      { task_id: 'task-review', team_role: 'reviewer', agent_id: 'independent-reviewer' },
    ]);
    expect(prompt).toContain('libs/core/artifact-review.ts');
    expect(prompt).toContain('code-reviewer');
    expect(tasks[0].reconciliation?.evidence?.[0]?.path).toBe('libs/core/artifact-review.ts');
    expect(tasks[1]).toMatchObject({
      status: 'completed',
      artifact_review_receipt: 'evidence/reviews/task-review-r1.json',
    });
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
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
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
    mocks.resolveMissionTeamReceiver.mockImplementation(({ teamRole }: { teamRole: string }) => ({
      agent_id: teamRole === 'reviewer' ? 'independent-reviewer' : 'implementation-architect',
      model_hint: {
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
        route_reason: 'phase_kind=mechanical -> small/low',
      },
    }));

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

    // Each accepted work result triggers an independent acceptance review ask.
    await new Promise((resolve) => setImmediate(resolve));
    const approveText = JSON.stringify({ approve: true, gaps: [], rationale: 'ok' });
    pendingResponses[2]?.resolve({ payload: { text: approveText } });
    await new Promise((resolve) => setImmediate(resolve));
    pendingResponses[3]?.resolve({ payload: { text: approveText } });

    const dispatched = await dispatchedPromise;
    const stored = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );

    expect(dispatched).toEqual([
      { task_id: 'task-a', team_role: 'implementer', agent_id: 'implementation-architect' },
      { task_id: 'task-b', team_role: 'implementer', agent_id: 'implementation-architect' },
    ]);
    expect(stored.map((task: any) => task.status)).toEqual(['completed', 'completed']);
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
    mocks.resolveMissionTeamReceiver.mockImplementation(({ teamRole }: { teamRole: string }) => ({
      agent_id: teamRole === 'reviewer' ? 'independent-reviewer' : 'implementation-architect',
      model_hint: {
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
        route_reason: 'phase_kind=mechanical -> small/low',
      },
    }));
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
    mocks.resolveMissionTeamReceiver.mockImplementation(({ teamRole }: { teamRole: string }) => ({
      agent_id: teamRole === 'reviewer' ? 'independent-reviewer' : 'implementation-architect',
      model_hint: {
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
        route_reason: 'phase_kind=mechanical -> small/low',
      },
    }));
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
      })
      // Independent acceptance review (separation of duties) approves.
      .mockResolvedValueOnce({
        payload: {
          text: JSON.stringify({ approve: true, gaps: [], rationale: 'Meets the criteria.' }),
        },
      });

    const dispatched = await dispatchMissionNextTasks('MSN-FOLLOWUP');

    expect(mocks.route).toHaveBeenCalledTimes(3);
    expect(dispatched).toEqual([
      { task_id: 'task-retry', team_role: 'implementer', agent_id: 'implementation-architect' },
    ]);
    const stored = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(stored[0].status).toBe('completed');
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

  it('retries once on acceptance-gate failure before blocking and notifying the owner', async () => {
    const { missionDir, pathResolver } = await import('./path-resolver.js');
    const { safeWriteFile, safeReadFile, safeExistsSync } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(
      `${missionPath}/deliverables/rework.md`,
      '# Rework target\nThe acceptance criteria are not yet satisfied.'
    );
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-rework',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Meet the acceptance criteria',
            deliverable: 'deliverables/rework.md',
            acceptance_criteria: ['Publish the rework summary'],
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
          summary:
            'The work item is complete but does not mention the requested acceptance phrase.',
          artifacts: [{ path: 'deliverables/rework.md', kind: 'markdown' }],
          verification_done: ['Wrote the deliverable.'],
          gaps: [],
          needs: [],
        }),
      },
    });

    const firstPass = await dispatchMissionNextTasks('MSN-FOLLOWUP');
    expect(firstPass).toEqual([
      { task_id: 'task-rework', team_role: 'implementer', agent_id: 'implementation-architect' },
    ]);

    let stored = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(stored[0].status).toBe('planned');
    expect(stored[0].rework_count).toBe(1);
    expect(safeExistsSync(`${missionPath}/gates`)).toBe(true);

    const secondPass = await dispatchMissionNextTasks('MSN-FOLLOWUP');
    expect(secondPass).toEqual([
      { task_id: 'task-rework', team_role: 'implementer', agent_id: 'implementation-architect' },
    ]);

    stored = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(stored[0].status).toBe('blocked');
    expect(stored[0].rework_count).toBe(2);

    const obsPath = `${process.env.KYBERION_TEST_OBSERVABILITY_DIR}/orchestration-events.jsonl`;
    const obsText = safeReadFile(obsPath, { encoding: 'utf8' }) as string;
    expect(obsText).toContain('mission_owner_notified');
    expect(obsText).toContain('task-rework');
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

  it('preserves process-template-seeded tasks when persisting a planner packet', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeReadFile, safeWriteFile } = await import('./secure-io.js');
    const { persistPlanningPacket } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    const seededTask = {
      task_id: 'audience_definition-audience-brief',
      status: 'planned',
      assigned_to: { role: 'planner' },
      description: 'Define the audience brief.',
      deliverable: 'evidence/audience-brief.json',
      dependencies: [],
      acceptance_criteria: ['audience defined'],
      risk: 'low',
      expected_output_format: 'structured',
      estimated_scope: 'S',
      phase: 'audience_definition',
      phase_kind: 'implement',
      origin: 'process_template',
    };
    safeWriteFile(`${missionPath}/NEXT_TASKS.json`, JSON.stringify([seededTask], null, 2));

    persistPlanningPacket('MSN-FOLLOWUP', {
      mission_id: 'MSN-FOLLOWUP',
      summary: 'Plan around the seeded skeleton',
      plan_markdown: '# PLAN\n\n## Objective\nPlan around the seeded skeleton\n',
      next_tasks: [
        {
          // Collides with the seeded task id — must be dropped, not clobber it.
          task_id: 'audience_definition-audience-brief',
          team_role: 'operator',
          description: 'Planner attempt to restructure the seeded task',
        },
        {
          task_id: 'extra-research',
          team_role: 'operator',
          description: 'Collect supplementary market research',
          deliverable: 'artifacts/research.md',
        },
      ],
    });

    const nextTasks = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    ) as Array<Record<string, unknown>>;

    expect(nextTasks[0]).toMatchObject({
      task_id: 'audience_definition-audience-brief',
      origin: 'process_template',
      description: 'Define the audience brief.',
    });
    expect(nextTasks.some((task) => task.task_id === 'extra-research')).toBe(true);
    expect(nextTasks).toHaveLength(2);
    expect(mocks.record).toHaveBeenCalledWith(
      'MISSION_PLAN_MERGED_WITH_PROCESS_TEMPLATE',
      expect.objectContaining({
        mission_id: 'MSN-FOLLOWUP',
        seeded_task_count: 1,
        planner_addition_count: 1,
        dropped_planner_task_count: 1,
      })
    );
  });

  it('re-prompts the planner once when the initial planning packet fails validation', async () => {
    const { resolveMissionPlanningPacket } = await import('./mission-orchestration-worker.js');
    const { safeExistsSync, safeReaddir, safeReadFile } = await import('./secure-io.js');
    const { missionDir } = await import('./path-resolver.js');

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
    const gateDir = `${missionDir('MSN-FOLLOWUP', 'public')}/gates`;
    expect(safeExistsSync(gateDir)).toBe(true);
    expect(safeReaddir(gateDir).some((entry: string) => entry.startsWith('planning-packet-'))).toBe(
      true
    );
    const gatePath = `${gateDir}/${safeReaddir(gateDir).find((entry: string) =>
      entry.startsWith('planning-packet-')
    )}`;
    const gateRecord = JSON.parse(safeReadFile(gatePath, { encoding: 'utf8' }) as string);
    expect(gateRecord).toMatchObject({
      planner_agent_id: 'planner-agent',
      review_round: 1,
      requires_independent_review: false,
    });
  });

  it('routes high-risk planning packets through an independent reviewer and re-plans once on rejection', async () => {
    const { resolveMissionPlanningPacket } = await import('./mission-orchestration-worker.js');
    const { safeExistsSync, safeReaddir, safeReadFile } = await import('./secure-io.js');
    const { missionDir } = await import('./path-resolver.js');

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
    const gateDir = `${missionDir('MSN-FOLLOWUP', 'public')}/gates`;
    expect(safeExistsSync(gateDir)).toBe(true);
    expect(safeReaddir(gateDir).some((entry: string) => entry.startsWith('planning-packet-'))).toBe(
      true
    );
    const gatePath = `${gateDir}/${safeReaddir(gateDir).find((entry: string) =>
      entry.startsWith('planning-packet-')
    )}`;
    const gateRecord = JSON.parse(safeReadFile(gatePath, { encoding: 'utf8' }) as string);
    expect(gateRecord).toMatchObject({
      planner_agent_id: 'planner-agent',
      reviewer_agent_id: 'review-agent',
      review_round: 2,
      requires_independent_review: true,
    });
    expect(gateRecord.review_verdict).toMatchObject({
      approve: true,
    });
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

  it('dispatches dependency-ready tasks after prerequisites complete within the same invocation', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile } = await import('./secure-io.js');
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
            assigned_to: { role: 'reviewer', agent_id: 'independent-reviewer' },
            description: 'Use the prerequisite output',
            dependencies: ['task-bootstrap'],
            deliverable: 'deliverables/REVIEW-task-bootstrap.md',
            review_target: 'task-bootstrap',
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
      team_governance: {
        lifecycle: {
          max_parallel_members: 1,
        },
      },
      assignments: [],
    });
    mocks.buildMissionTeamView.mockReturnValue({ planner: 'nerve-agent' });
    mocks.resolveMissionTeamReceiver.mockImplementation(({ teamRole }: { teamRole: string }) => ({
      agent_id: teamRole === 'reviewer' ? 'independent-reviewer' : 'implementation-architect',
      model_hint: {
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
        route_reason: 'phase_kind=mechanical -> small/low',
      },
    }));
    const pendingResponses: Array<{ resolve: (value: any) => void }> = [];
    mocks.route.mockImplementation(
      () =>
        new Promise((resolve) => {
          pendingResponses.push({ resolve });
        })
    );

    const dispatchedPromise = dispatchMissionNextTasks('MSN-FOLLOWUP');
    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.route).toHaveBeenCalledTimes(1);
    expect(String((mocks.route.mock.calls[0]?.[0] as any)?.payload?.context?.task_id || '')).toBe(
      'task-bootstrap'
    );

    pendingResponses[0]?.resolve({
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

    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.route).toHaveBeenCalledTimes(2);
    expect(String((mocks.route.mock.calls[1]?.[0] as any)?.payload?.context?.task_id || '')).toBe(
      'task-followup'
    );

    pendingResponses[1]?.resolve({
      payload: {
        text: makeTaskResultText({
          summary: 'Completed the follow-up task.',
          artifacts: [{ path: 'deliverables/followup.md', kind: 'markdown' }],
          verification_done: ['Confirmed the follow-up output.'],
          gaps: [],
          needs: [],
        }),
      },
    });

    const dispatched = await dispatchedPromise;

    expect(dispatched).toEqual([
      { task_id: 'task-bootstrap', team_role: 'implementer', agent_id: 'implementation-architect' },
      { task_id: 'task-followup', team_role: 'reviewer', agent_id: 'independent-reviewer' },
    ]);
  });

  it('injects upstream results and team snapshot, then replays reviewer findings as rework', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile, safeReadFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(`${missionPath}/deliverables/REVIEW-task-1.md`, '# review notes');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-1',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Implement the base work',
            deliverable: 'deliverables/task-a.md',
          },
          {
            task_id: 'task-2',
            status: 'planned',
            assigned_to: { role: 'reviewer', agent_id: 'implementation-architect' },
            description: 'Review the implementation',
            deliverable: 'deliverables/REVIEW-task-1.md',
            dependencies: ['task-1'],
            review_target: 'task-1',
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
    mocks.resolveMissionTeamReceiver.mockImplementation(({ teamRole }: { teamRole: string }) => ({
      agent_id: teamRole === 'reviewer' ? 'independent-reviewer' : 'implementation-architect',
      model_hint: {
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
        route_reason: 'phase_kind=mechanical -> small/low',
      },
    }));
    mocks.route.mockImplementation(async (envelope: any) => {
      const taskId = String(envelope?.payload?.context?.task_id || '');
      const prompt = String(envelope?.payload?.text || '');
      if (taskId === 'task-1' && prompt.includes('## Review findings to address')) {
        return {
          payload: {
            text: makeTaskResultText({
              summary: 'Reworked the implementation.',
              artifacts: [{ path: 'deliverables/task-a.md', kind: 'markdown' }],
              verification_done: ['Addressed the reviewer findings.'],
              gaps: [],
              needs: [],
            }),
          },
        };
      }
      if (taskId === 'task-1') {
        return {
          payload: {
            text: makeTaskResultText({
              summary: 'Completed the base implementation.',
              artifacts: [{ path: 'deliverables/task-a.md', kind: 'markdown' }],
              verification_done: ['Confirmed the base implementation.'],
              gaps: [],
              needs: [],
            }),
          },
        };
      }
      if (taskId === 'task-2' && prompt.includes('Review findings to address')) {
        return {
          payload: {
            text: makeTaskResultText({
              summary: 'The implementation now passes review.',
              artifacts: [{ path: 'deliverables/REVIEW-task-1.md', kind: 'markdown' }],
              verification_done: ['Confirmed the revised implementation.'],
              gaps: [],
              needs: [],
            }),
          },
        };
      }
      return {
        payload: {
          text: makeTaskResultText({
            summary: 'Review found one must-fix issue.',
            artifacts: [{ path: 'deliverables/REVIEW-task-1.md', kind: 'markdown' }],
            verification_done: ['Reviewed the target work.'],
            gaps: ['Clarify the implementation heading hierarchy.'],
            needs: [],
            review_findings: [
              {
                severity: 'must_fix',
                location: 'deliverables/task-a.md',
                instruction: 'Clarify the implementation heading hierarchy.',
              },
            ],
          }),
        },
      };
    });

    const dispatched = await dispatchMissionNextTasks('MSN-FOLLOWUP');

    expect(mocks.route).toHaveBeenCalledTimes(4);
    const prompts = mocks.route.mock.calls.map((call) =>
      String((call[0] as any)?.payload?.text || '')
    );
    expect(prompts[1]).toContain('## Upstream results (inputs you MUST build on)');
    expect(prompts[1]).toContain('Completed the base implementation.');
    expect(prompts[1]).toContain('deliverables/task-a.md');
    expect(prompts[1]).toContain('## Artifact quality review mandate');
    expect(prompts[1]).toContain('content-reviewer');
    expect(prompts[1]).toContain(
      '## Team snapshot (do not duplicate; stay consistent with completed work)'
    );
    expect(prompts[2]).toContain('## Review findings to address');
    expect(prompts[2]).toContain('must_fix @ deliverables/task-a.md');
    expect(mocks.resolveMissionTeamReceiver).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'MSN-FOLLOWUP',
        teamRole: 'reviewer',
        excludedAgentIds: ['implementation-architect'],
        requiredCapabilities: expect.arrayContaining(['review', 'documentation', 'analysis']),
      })
    );

    expect(dispatched).toEqual([
      { task_id: 'task-1', team_role: 'implementer', agent_id: 'implementation-architect' },
      { task_id: 'task-2', team_role: 'reviewer', agent_id: 'independent-reviewer' },
      { task_id: 'task-1', team_role: 'implementer', agent_id: 'implementation-architect' },
      { task_id: 'task-2', team_role: 'reviewer', agent_id: 'independent-reviewer' },
    ]);

    const stored = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(stored.map((task: any) => task.status)).toEqual(['completed', 'completed']);
    expect(stored[0].rework_count).toBe(1);
    expect(stored[0].last_result.summary).toContain('Reworked the implementation.');
    expect(stored[1].review_target).toBe('task-1');
    expect(stored[1].artifact_review_receipt).toBe('evidence/reviews/task-2-r2.json');
    const receipt = JSON.parse(
      safeReadFile(`${missionPath}/${stored[1].artifact_review_receipt}`, {
        encoding: 'utf8',
      }) as string
    );
    expect(receipt).toMatchObject({
      kind: 'artifact-review-receipt',
      review_target_task_id: 'task-1',
      verdict: 'approved',
      reviewer: {
        agent_id: 'independent-reviewer',
        specialist_roles: ['content-reviewer'],
        independence_verified: true,
      },
    });
    expect(receipt.artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('retries a busy task on the next wave when another task makes progress', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
    const { AgentBusyError } =
      await vi.importActual<typeof import('./a2a-bridge.js')>('./a2a-bridge.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-busy',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Retry when the agent is briefly busy',
            deliverable: 'deliverables/busy.md',
          },
          {
            task_id: 'task-stable',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Progress even if another task is busy',
            deliverable: 'deliverables/stable.md',
          },
        ],
        null,
        2
      )
    );
    safeWriteFile(`${missionPath}/deliverables/busy.md`, '# busy');
    safeWriteFile(`${missionPath}/deliverables/stable.md`, '# stable');
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
    mocks.route
      .mockRejectedValueOnce(new AgentBusyError('busy', 10))
      .mockResolvedValueOnce({
        payload: {
          text: makeTaskResultText({
            summary: 'Completed the stable task.',
            artifacts: [{ path: 'deliverables/stable.md', kind: 'markdown' }],
            verification_done: ['Confirmed the stable output.'],
            gaps: [],
            needs: [],
          }),
        },
      })
      .mockResolvedValueOnce({
        payload: {
          text: makeTaskResultText({
            summary: 'Completed the busy task after retry.',
            artifacts: [{ path: 'deliverables/busy.md', kind: 'markdown' }],
            verification_done: ['Confirmed the busy output.'],
            gaps: [],
            needs: [],
          }),
        },
      });

    const dispatched = await dispatchMissionNextTasks('MSN-FOLLOWUP');

    expect(mocks.route).toHaveBeenCalledTimes(3);
    expect(dispatched).toEqual([
      { task_id: 'task-stable', team_role: 'implementer', agent_id: 'implementation-architect' },
      { task_id: 'task-busy', team_role: 'implementer', agent_id: 'implementation-architect' },
    ]);
  });

  it('rejects malformed NEXT_TASKS input before dispatching', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-a',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Task A',
          },
          {
            task_id: 'task-a',
            status: 'planned',
            assigned_to: { role: 'reviewer', agent_id: 'implementation-architect' },
            description: 'Duplicate task id',
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

    await expect(dispatchMissionNextTasks('MSN-FOLLOWUP')).rejects.toThrow(
      /duplicate task_id task-a/
    );
    expect(mocks.route).not.toHaveBeenCalled();
  });

  it('rejects reviewer tasks that omit review_target or review deliverables', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-review',
            status: 'planned',
            assigned_to: { role: 'reviewer', agent_id: 'implementation-architect' },
            description: 'Review the implementation',
            deliverable: 'deliverables/REVIEW-task-review.md',
            dependencies: ['task-base'],
          },
          {
            task_id: 'task-base',
            status: 'completed',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Base implementation',
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

    await expect(dispatchMissionNextTasks('MSN-FOLLOWUP')).rejects.toThrow(
      /reviewer task task-review is missing review_target/
    );
    expect(mocks.route).not.toHaveBeenCalled();
  });

  it('rejects reviewer tasks that do not depend on their review target', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-review',
            status: 'planned',
            assigned_to: { role: 'reviewer', agent_id: 'implementation-architect' },
            description: 'Review the implementation',
            deliverable: 'deliverables/REVIEW-task-target.md',
            dependencies: ['task-base'],
            review_target: 'task-target',
          },
          {
            task_id: 'task-base',
            status: 'completed',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Base implementation',
            deliverable: 'deliverables/task-a.md',
          },
          {
            task_id: 'task-target',
            status: 'completed',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Target implementation',
            deliverable: 'deliverables/task-target.md',
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

    await expect(dispatchMissionNextTasks('MSN-FOLLOWUP')).rejects.toThrow(
      /reviewer task task-review must depend on review_target task-target/
    );
    expect(mocks.route).not.toHaveBeenCalled();
  });

  it('keeps the final task state equivalent between serial and parallel dispatch', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile, safeReadFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
    const { clearWorkCoordinationStore } = await import('./work-coordination.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    const writeFixture = (maxParallelMembers: number) => {
      clearWorkCoordinationStore();
      mocks.route.mockReset();
      mocks.resolveMissionTeamPlan.mockReset();
      mocks.resolveMissionTeamPlan.mockReturnValue({
        mission_id: 'MSN-FOLLOWUP',
        mission_type: 'product_development',
        team_governance: {
          lifecycle: {
            max_parallel_members: maxParallelMembers,
          },
        },
        assignments: [],
      });
      mocks.route.mockImplementation(async (request: any) => {
        const taskId = String(request?.payload?.context?.task_id || '');
        const deliverableName =
          taskId === 'task-bootstrap'
            ? 'bootstrap'
            : taskId === 'task-followup'
              ? 'REVIEW-task-bootstrap'
              : taskId === 'task-independent'
                ? 'independent'
                : taskId;
        return {
          payload: {
            text: makeTaskResultText({
              summary: `Completed ${taskId}.`,
              artifacts: [{ path: `deliverables/${deliverableName}.md`, kind: 'markdown' }],
              verification_done: [`Confirmed ${taskId}.`],
              gaps: [],
              needs: [],
            }),
          },
        };
      });
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
              assigned_to: { role: 'reviewer', agent_id: 'independent-reviewer' },
              description: 'Use the prerequisite output',
              dependencies: ['task-bootstrap'],
              deliverable: 'deliverables/REVIEW-task-bootstrap.md',
              review_target: 'task-bootstrap',
            },
            {
              task_id: 'task-independent',
              status: 'planned',
              assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
              description: 'Run in parallel with the chain',
              deliverable: 'deliverables/independent.md',
            },
          ],
          null,
          2
        )
      );
      safeWriteFile(`${missionPath}/deliverables/independent.md`, '# independent');
      safeWriteFile(`${missionPath}/deliverables/REVIEW-task-bootstrap.md`, '# review bootstrap');
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
    };

    mocks.ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue({
      runtime_plan: { mission_id: 'MSN-FOLLOWUP', assignments: [] },
    });
    mocks.buildMissionTeamView.mockReturnValue({ planner: 'nerve-agent' });
    mocks.resolveMissionTeamReceiver.mockImplementation(({ teamRole }: { teamRole: string }) => ({
      agent_id: teamRole === 'reviewer' ? 'independent-reviewer' : 'implementation-architect',
      model_hint: {
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
        route_reason: 'phase_kind=mechanical -> small/low',
      },
    }));

    writeFixture(1);
    await dispatchMissionNextTasks('MSN-FOLLOWUP');
    const serialSnapshot = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );

    writeFixture(2);
    await dispatchMissionNextTasks('MSN-FOLLOWUP');
    const parallelSnapshot = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );

    const normalize = (entries: any[]) =>
      entries
        .map((entry) => ({
          task_id: entry.task_id,
          status: entry.status,
          rework_count: Number(entry.rework_count || 0),
        }))
        .sort((left, right) => left.task_id.localeCompare(right.task_id));

    expect(normalize(serialSnapshot)).toEqual(normalize(parallelSnapshot));
    expect(normalize(serialSnapshot)).toEqual([
      { task_id: 'task-bootstrap', status: 'completed', rework_count: 0 },
      { task_id: 'task-followup', status: 'completed', rework_count: 0 },
      { task_id: 'task-independent', status: 'completed', rework_count: 0 },
    ]);
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
