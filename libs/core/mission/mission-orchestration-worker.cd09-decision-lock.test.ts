import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CD-09: the worker pins the case's customer decisions right after the task's
// WorkItem import and reconciles them just before the WorkItem goes `done`.
// A stale result still completes the task, and only counts, the consumer id
// and WorkItem ids reach the (public) task event.
const mocks = vi.hoisted(() => ({
  route: vi.fn(),
  ensureMissionTeamRuntimeViaSupervisor: vi.fn(),
  shutdownAllAgentRuntimes: vi.fn(),
  resolveMissionTeamPlan: vi.fn(),
  loadMissionTeamPlan: vi.fn(),
  resolveMissionTeamReceiver: vi.fn(),
  buildMissionTeamView: vi.fn(),
  record: vi.fn(),
  emitMissionTaskEvent: vi.fn(),
  findRelevantDistilledKnowledge: vi.fn(),
  pinTaskDecisions: vi.fn(),
  reconcileTaskDecisions: vi.fn(),
  importExternalWorkItem: vi.fn(),
  updateWorkItem: vi.fn(),
}));

function makeTaskResultText(input: { summary: string; needs?: string[]; gaps?: string[] }): string {
  return [
    '```task_result',
    JSON.stringify({
      summary: input.summary,
      artifacts: [],
      verification_done: [],
      gaps: input.gaps || [],
      needs: input.needs || [],
    }),
    '```',
  ].join('\n');
}

vi.mock('../mesh/a2a-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mesh/a2a-bridge.js')>();
  return {
    ...actual,
    a2aBridge: {
      ...actual.a2aBridge,
      route: mocks.route,
    },
  };
});

vi.mock('../agent/agent-runtime-supervisor.js', () => ({
  ensureMissionTeamRuntimeViaSupervisor: mocks.ensureMissionTeamRuntimeViaSupervisor,
  shutdownAllAgentRuntimes: mocks.shutdownAllAgentRuntimes,
}));

vi.mock('./mission-team-plan-composer.js', () => ({
  resolveMissionTeamPlan: mocks.resolveMissionTeamPlan,
  loadMissionTeamPlan: mocks.loadMissionTeamPlan,
  resolveMissionTeamReceiver: mocks.resolveMissionTeamReceiver,
  buildMissionTeamView: mocks.buildMissionTeamView,
}));

vi.mock('../ledger.js', () => ({
  ledger: { record: mocks.record },
}));

vi.mock('./mission-task-events.js', () => ({
  emitMissionTaskEvent: mocks.emitMissionTaskEvent,
  missionTaskEventsPath: (missionId: string) =>
    `active/missions/public/${missionId}/coordination/events/task-events.jsonl`,
}));

vi.mock('../knowledge/distill-knowledge-injector.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../knowledge/distill-knowledge-injector.js')>();
  return {
    ...actual,
    findRelevantDistilledKnowledge: mocks.findRelevantDistilledKnowledge,
  };
});

vi.mock('./mission-decision-lock.js', () => ({
  pinTaskDecisions: mocks.pinTaskDecisions,
  reconcileTaskDecisions: mocks.reconcileTaskDecisions,
  CUSTOMER_DECISION_BLOCKED_REASONS: [
    'awaiting_customer_decision',
    'customer_decision_check_failed',
  ],
  // Every structured result re-checks the task's holds; none here.
  recordTaskDecisionProposals: () => ({
    case_found: false,
    consumer: 'mission-MSN-CD09-WORKER.task-1',
    recorded: 0,
    proposal_ids: [],
    hold_proposal_ids: [],
  }),
}));

vi.mock('../workforce/work-coordination.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workforce/work-coordination.js')>();
  mocks.importExternalWorkItem.mockImplementation(actual.importExternalWorkItem);
  mocks.updateWorkItem.mockImplementation(actual.updateWorkItem);
  return {
    ...actual,
    importExternalWorkItem: (...args: Parameters<typeof actual.importExternalWorkItem>) =>
      mocks.importExternalWorkItem(...args),
    updateWorkItem: (...args: Parameters<typeof actual.updateWorkItem>) =>
      mocks.updateWorkItem(...args),
  };
});

const MISSION_ID = 'MSN-CD09-WORKER';

// Full dispatch flow through real module wiring (kp04-needs style); only the
// CD-09 lock seam is mocked — its behavior is covered by mission-decision-lock.test.ts.
describe('mission-orchestration-worker CD-09 customer decision lock', { timeout: 60_000 }, () => {
  beforeEach(async () => {
    // No vi.resetModules(): the module under test and the secure-io / tier-guard /
    // authority stack under it are imported once per file (the first `await
    // import`; later ones hit the module cache). Re-importing that stack per test
    // repeated its module initialisation every test (operations-hygiene-runbook §5).
    // Per-test state is reset through the work-coordination namespace/store and the mocks.
    vi.resetAllMocks();
    process.env.MISSION_ROLE = 'mission_controller';
    const { missionDir, pathResolver } = await import('../path-resolver.js');
    process.env.KYBERION_TEST_OBSERVABILITY_DIR = pathResolver.shared(
      `tmp/vitest-observability/cd09-lock-${process.pid}`
    );
    process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR = pathResolver.shared(
      `tmp/vitest-knowledge-delivery/cd09-lock-${process.pid}`
    );
    process.env.KYBERION_KNOWLEDGE_USAGE_PATH = pathResolver.shared(
      `tmp/vitest-knowledge-usage/cd09-lock-${process.pid}/usage.json`
    );
    process.env.KYBERION_MEMORY_QUEUE_PATH = pathResolver.shared(
      `tmp/vitest-memory-queue/cd09-lock-${process.pid}/promotion-queue.jsonl`
    );
    {
      const { safeMkdir: mkdirForQueue } = await import('../secure-io.js');
      const nodePathModule = await import('node:path');
      mkdirForQueue(nodePathModule.dirname(process.env.KYBERION_MEMORY_QUEUE_PATH), {
        recursive: true,
      });
    }
    const { clearWorkCoordinationStore, setWorkCoordinationNamespace } =
      await import('../workforce/work-coordination.js');
    const { safeMkdir, safeWriteFile } = await import('../secure-io.js');
    setWorkCoordinationNamespace('mission-orchestration-worker-cd09-lock-test');
    clearWorkCoordinationStore();
    const missionPath = missionDir(MISSION_ID, 'public');
    safeMkdir(missionPath, { recursive: true });
    safeMkdir(`${missionPath}/deliverables`, { recursive: true });
    safeWriteFile(`${missionPath}/deliverables/widget.md`, '# widget');
    safeWriteFile(
      `${missionPath}/mission-state.json`,
      JSON.stringify(
        {
          mission_id: MISSION_ID,
          mission_type: 'development',
          tier: 'public',
          status: 'active',
          execution_mode: 'local',
          priority: 3,
          assigned_persona: 'worker',
          confidence_score: 1,
          git: {
            branch: 'mission/cd09-lock',
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
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-1',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Implement the widget procedure',
            deliverable: 'deliverables/widget.md',
          },
        ],
        null,
        2
      )
    );
    safeWriteFile(
      `${missionPath}/TASK_BOARD.md`,
      [
        `# TASK_BOARD: ${MISSION_ID}`,
        '',
        '## Status: Planning Ready',
        '',
        '### Execution Phase',
        '- [ ] Step 2: Implementation',
        '',
      ].join('\n')
    );

    mocks.ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue({
      runtime_plan: { mission_id: MISSION_ID, assignments: [] },
    });
    mocks.resolveMissionTeamPlan.mockReturnValue({
      mission_id: MISSION_ID,
      mission_type: 'development',
      assignments: [],
    });
    mocks.buildMissionTeamView.mockReturnValue({ planner: 'nerve-agent' });
    // Single team role staffed for this fixture — the same agent_id comes
    // back for team_role 'reviewer' too, which makes
    // requestIndependentAcceptanceReview skip itself (reviewer === worker)
    // instead of issuing a third a2aBridge.route call this test doesn't
    // script.
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
    const { missionDir } = await import('../path-resolver.js');
    const { clearWorkCoordinationStore, clearWorkCoordinationNamespace } =
      await import('../workforce/work-coordination.js');
    const { safeExistsSync, safeRmSync } = await import('../secure-io.js');
    const missionPath = missionDir(MISSION_ID, 'public');
    if (safeExistsSync(missionPath)) safeRmSync(missionPath);
    const observabilityDir = process.env.KYBERION_TEST_OBSERVABILITY_DIR;
    if (observabilityDir && safeExistsSync(observabilityDir)) safeRmSync(observabilityDir);
    delete process.env.KYBERION_TEST_OBSERVABILITY_DIR;
    for (const envVar of [
      'KYBERION_KNOWLEDGE_DELIVERY_DIR',
      'KYBERION_KNOWLEDGE_USAGE_PATH',
      'KYBERION_MEMORY_QUEUE_PATH',
    ]) {
      const dir = process.env[envVar];
      if (dir && safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
      delete process.env[envVar];
    }
    clearWorkCoordinationStore();
    clearWorkCoordinationNamespace();
  });

  function completedEvent() {
    return mocks.emitMissionTaskEvent.mock.calls
      .map((call) => call[0] as { event_type?: string; payload?: Record<string, unknown> })
      .find((event) => event.event_type === 'task_completed');
  }

  it('pins after the WorkItem import and reconciles before done; stale still completes', async () => {
    const actual = await vi.importActual<typeof import('../workforce/work-coordination.js')>(
      '../workforce/work-coordination.js'
    );
    mocks.importExternalWorkItem.mockImplementation(actual.importExternalWorkItem);
    mocks.updateWorkItem.mockImplementation(actual.updateWorkItem);
    mocks.findRelevantDistilledKnowledge.mockResolvedValue([]);
    mocks.pinTaskDecisions.mockReturnValue({
      consumer: 'mission-MSN-CD09-WORKER.task-1',
      pinned_count: 3,
      pinned: true,
    });
    mocks.reconcileTaskDecisions.mockReturnValue({
      consumer: 'mission-MSN-CD09-WORKER.task-1',
      checked: 3,
      stale_count: 1,
      rework_work_item_ids: ['WI-CDR-0123456789ABCDEF'],
    });
    mocks.route.mockResolvedValueOnce({
      payload: { text: makeTaskResultText({ summary: 'Completed the widget.' }) },
    });
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
    await dispatchMissionNextTasks(MISSION_ID);

    expect(mocks.pinTaskDecisions).toHaveBeenCalledWith({
      missionId: MISSION_ID,
      taskId: 'task-1',
      mode: 'start',
    });
    expect(mocks.reconcileTaskDecisions).toHaveBeenCalledWith({
      missionId: MISSION_ID,
      taskId: 'task-1',
    });
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0];
    const doneCall = mocks.updateWorkItem.mock.calls.findIndex(
      (call) => (call[0] as { status?: string }).status === 'done'
    );
    expect(doneCall).toBeGreaterThanOrEqual(0);
    expect(order(mocks.importExternalWorkItem)).toBeLessThan(order(mocks.pinTaskDecisions));
    expect(order(mocks.pinTaskDecisions)).toBeLessThan(order(mocks.route));
    expect(order(mocks.reconcileTaskDecisions)).toBeLessThan(
      mocks.updateWorkItem.mock.invocationCallOrder[doneCall]
    );
    expect(order(mocks.route)).toBeLessThan(order(mocks.reconcileTaskDecisions));
    // Stale decisions do not block completion; the event carries counts and ids only.
    const event = completedEvent();
    expect(event?.payload?.customer_decision_lock).toEqual({
      consumer: 'mission-MSN-CD09-WORKER.task-1',
      pinned_count: 3,
      checked: 3,
      stale_count: 1,
      rework_work_item_ids: ['WI-CDR-0123456789ABCDEF'],
    });
  });

  it('adds nothing to the task event for a mission without a decision case', async () => {
    const actual = await vi.importActual<typeof import('../workforce/work-coordination.js')>(
      '../workforce/work-coordination.js'
    );
    mocks.importExternalWorkItem.mockImplementation(actual.importExternalWorkItem);
    mocks.updateWorkItem.mockImplementation(actual.updateWorkItem);
    mocks.findRelevantDistilledKnowledge.mockResolvedValue([]);
    mocks.pinTaskDecisions.mockReturnValue(null);
    mocks.reconcileTaskDecisions.mockReturnValue({
      checked: 0,
      stale_count: 0,
      rework_work_item_ids: [],
    });
    mocks.route.mockResolvedValueOnce({
      payload: { text: makeTaskResultText({ summary: 'Completed the widget.' }) },
    });
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
    await dispatchMissionNextTasks(MISSION_ID);
    const event = completedEvent();
    expect(event).toBeDefined();
    expect(event?.payload).not.toHaveProperty('customer_decision_lock');
  });
});
