import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CD-09 実装中の判断を顧客に回す: the worker takes `customer_decisions` out of
// the task result before anything is stored, hands them to the decision lock
// (confidential), completes on the proposals, holds the task on a
// requires_customer question (WorkItem blocked, awaiting_customer_decision),
// and — without a decision case — turns requires_customer questions into
// ordinary needs. Public evidence and events carry ids and counts only.
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
  recordTaskDecisionProposals: vi.fn(),
  importExternalWorkItem: vi.fn(),
  updateWorkItem: vi.fn(),
}));

function makeTaskResultText(input: {
  summary: string;
  needs?: string[];
  customer_decisions?: unknown[];
}): string {
  return [
    '```task_result',
    JSON.stringify({
      summary: input.summary,
      artifacts: [],
      verification_done: ['checked the widget'],
      gaps: [],
      needs: input.needs || [],
      ...(input.customer_decisions ? { customer_decisions: input.customer_decisions } : {}),
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
  recordTaskDecisionProposals: mocks.recordTaskDecisionProposals,
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

const MISSION_ID = 'MSN-CD09-PROPOSALS';

// Full dispatch flow through real module wiring (kp04-needs style); only the
// CD-09 lock seam is mocked — its behavior is covered by mission-decision-lock.test.ts.
describe(
  'mission-orchestration-worker CD-09 customer decision proposals',
  { timeout: 60_000 },
  () => {
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
        `tmp/vitest-observability/cd09-proposals-${process.pid}`
      );
      process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR = pathResolver.shared(
        `tmp/vitest-knowledge-delivery/cd09-proposals-${process.pid}`
      );
      process.env.KYBERION_KNOWLEDGE_USAGE_PATH = pathResolver.shared(
        `tmp/vitest-knowledge-usage/cd09-proposals-${process.pid}/usage.json`
      );
      process.env.KYBERION_MEMORY_QUEUE_PATH = pathResolver.shared(
        `tmp/vitest-memory-queue/cd09-proposals-${process.pid}/promotion-queue.jsonl`
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
      setWorkCoordinationNamespace('mission-orchestration-worker-cd09-proposals-test');
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
              branch: 'mission/cd09-proposals',
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

    const SECRET = /secret|ui\.theme|release\.go|"UX"|RELEASE/u;
    const THEME = {
      question: 'Which secret colour theme?',
      item: 'UX',
      key: 'ui.theme',
      proposed_value: 'secret-dark',
      requires_customer: false,
    };
    const RELEASE_ASK = {
      question: 'May we ship the secret build?',
      item: 'RELEASE',
      key: 'release.go',
      requires_customer: true,
    };

    async function dispatch(customerDecisions: unknown[]) {
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
      const text = makeTaskResultText({
        summary: 'Completed the widget.',
        customer_decisions: customerDecisions,
      });
      mocks.route.mockResolvedValue({ payload: { text } });
      const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
      await dispatchMissionNextTasks(MISSION_ID);
    }

    async function publicTrail(): Promise<string> {
      const { missionDir } = await import('../path-resolver.js');
      const { safeExistsSync, safeReadFile } = await import('../secure-io.js');
      const missionPath = missionDir(MISSION_ID, 'public');
      const files = [
        `${missionPath}/NEXT_TASKS.json`,
        `${missionPath}/evidence/task-clarification-task-1.json`,
      ];
      return [
        JSON.stringify(mocks.emitMissionTaskEvent.mock.calls),
        JSON.stringify(mocks.updateWorkItem.mock.calls),
        ...files
          .filter((file) => safeExistsSync(file))
          .map((file) => String(safeReadFile(file, { encoding: 'utf8' }))),
      ].join('\n');
    }

    const doneCalled = () =>
      mocks.updateWorkItem.mock.calls.some(
        (call) => (call[0] as { status?: string }).status === 'done'
      );
    const blockedCall = () =>
      mocks.updateWorkItem.mock.calls
        .map((call) => call[0] as { status?: string; metadata?: Record<string, unknown> })
        .find((call) => call.status === 'blocked');

    it('completes on its proposals and keeps their content out of public evidence', async () => {
      mocks.recordTaskDecisionProposals.mockReturnValue({
        case_found: true,
        consumer: 'mission-MSN-CD09-PROPOSALS.task-1',
        case_id: 'PRJ-1',
        recorded: 1,
        proposal_ids: ['tp-0123456789abcdef'],
        hold_proposal_ids: [],
      });
      await dispatch([THEME]);
      expect(mocks.recordTaskDecisionProposals).toHaveBeenCalledWith({
        missionId: MISSION_ID,
        taskId: 'task-1',
        requests: [THEME],
        workItemId: expect.any(String),
      });
      expect(doneCalled()).toBe(true);
      const completed = mocks.emitMissionTaskEvent.mock.calls
        .map((call) => call[0] as { event_type?: string; payload?: Record<string, unknown> })
        .find((event) => event.event_type === 'task_completed');
      expect(completed?.payload?.customer_decision_proposals).toEqual({
        consumer: 'mission-MSN-CD09-PROPOSALS.task-1',
        recorded_count: 1,
        proposal_ids: ['tp-0123456789abcdef'],
      });
      expect(await publicTrail()).not.toMatch(SECRET);
    });

    it('holds the task on a requires_customer question: blocked, awaiting_customer_decision, ids only', async () => {
      mocks.recordTaskDecisionProposals.mockReturnValue({
        case_found: true,
        consumer: 'mission-MSN-CD09-PROPOSALS.task-1',
        case_id: 'PRJ-1',
        recorded: 2,
        proposal_ids: ['tp-0123456789abcdef', 'tp-fedcba9876543210'],
        hold_proposal_ids: ['tp-fedcba9876543210'],
      });
      await dispatch([THEME, RELEASE_ASK]);
      expect(blockedCall()?.metadata).toMatchObject({
        blocked_reason: 'awaiting_customer_decision',
        customer_decision_hold: {
          status: 'awaiting',
          hold_count: 1,
          hold_proposal_ids: ['tp-fedcba9876543210'],
        },
      });
      expect(doneCalled()).toBe(false);
      // Reconcile is for completed tasks only.
      expect(mocks.reconcileTaskDecisions).not.toHaveBeenCalled();
      const { missionDir } = await import('../path-resolver.js');
      const { safeReadFile } = await import('../secure-io.js');
      const missionPath = missionDir(MISSION_ID, 'public');
      const evidence = JSON.parse(
        String(
          safeReadFile(`${missionPath}/evidence/task-clarification-task-1.json`, {
            encoding: 'utf8',
          })
        )
      );
      expect(evidence).toMatchObject({
        status: 'awaiting_customer_decision',
        customer_decision_hold: { hold_count: 1, recorded_count: 2 },
      });
      const tasks = JSON.parse(
        String(safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }))
      );
      expect(tasks[0].status).toBe('blocked');
      expect(tasks[0].last_result).not.toHaveProperty('customer_decisions');
      expect(await publicTrail()).not.toMatch(SECRET);
    });

    it('without a decision case: a requires_customer question becomes an ordinary need', async () => {
      mocks.recordTaskDecisionProposals.mockReturnValue({
        case_found: false,
        consumer: 'mission-MSN-CD09-PROPOSALS.task-1',
        recorded: 0,
        proposal_ids: [],
        hold_proposal_ids: [],
      });
      await dispatch([THEME, RELEASE_ASK]);
      expect(blockedCall()?.metadata?.blocked_reason).toBe('task_result_needs_input');
      const clarification = mocks.emitMissionTaskEvent.mock.calls
        .map((call) => call[0] as { payload?: Record<string, unknown> })
        .find((event) => Array.isArray(event.payload?.needs));
      expect(clarification?.payload?.needs).toEqual(['May we ship the secret build?']);
    });

    it('without a decision case: a plain proposal just goes on', async () => {
      mocks.recordTaskDecisionProposals.mockReturnValue({
        case_found: false,
        consumer: 'mission-MSN-CD09-PROPOSALS.task-1',
        recorded: 0,
        proposal_ids: [],
        hold_proposal_ids: [],
      });
      await dispatch([THEME]);
      expect(blockedCall()).toBeUndefined();
      expect(doneCalled()).toBe(true);
    });
  }
);
