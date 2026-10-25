import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CD-09: the worker pins the case's customer decisions right before the task's
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
  auditTaskDecisionDelivery: vi.fn(),
  provisionTaskKnowledge: vi.fn(),
  recordMissionVisiblePrompt: vi.fn(),
  requestIndependentAcceptanceReview: vi.fn(),
  notifyOperator: vi.fn(),
  addInboxEntry: vi.fn(),
  emitMissionOrchestrationObservation: vi.fn(),
  markTaskDecisionLockSuperseded: vi.fn(),
  /** Set per test: the security scope the (real) context pack is given. */
  packScope: { value: undefined as Record<string, unknown> | undefined },
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

// The passthrough implementations are set in beforeEach (a factory runs on the
// first import, which may come after a test set its own implementation).
vi.mock('../task/task-knowledge-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../task/task-knowledge-provisioning.js')>();
  return {
    ...actual,
    provisionTaskKnowledge: async (...args: Parameters<typeof actual.provisionTaskKnowledge>) => {
      const provisioned = await mocks.provisionTaskKnowledge(...args);
      return mocks.packScope.value && provisioned.pack
        ? {
            ...provisioned,
            pack: { ...provisioned.pack, security_scope: mocks.packScope.value },
          }
        : provisioned;
    },
  };
});

vi.mock('./mission-orchestration-worker-part-context.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./mission-orchestration-worker-part-context.js')>();
  return {
    ...actual,
    recordMissionVisiblePrompt: (...args: Parameters<typeof actual.recordMissionVisiblePrompt>) =>
      mocks.recordMissionVisiblePrompt(...args),
    requestIndependentAcceptanceReview: (
      ...args: Parameters<typeof actual.requestIndependentAcceptanceReview>
    ) => mocks.requestIndependentAcceptanceReview(...args),
    // The fixture scope (confidential, tenant-bound) does not match the public
    // fixture mission's directory; the compactor (cached per mission) places
    // its own records by that scope, so it keeps the mission's real one.
    maybeCompactDispatchSections: (
      input: Parameters<typeof actual.maybeCompactDispatchSections>[0]
    ) =>
      actual.maybeCompactDispatchSections(
        mocks.packScope.value ? { ...input, securityScope: undefined } : input
      ),
  };
});

vi.mock('../surface/operator-notifications.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../surface/operator-notifications.js')>()),
  notifyOperator: (...args: unknown[]) => mocks.notifyOperator(...args),
}));

// The escalation's inbox entry and owner notification are observed, never
// written to the shared runtime stores.
vi.mock('../deliverable-inbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../deliverable-inbox.js')>()),
  addInboxEntry: (...args: unknown[]) => mocks.addInboxEntry(...args),
}));

vi.mock('./mission-orchestration-events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mission-orchestration-events.js')>();
  return {
    ...actual,
    emitMissionOrchestrationObservation: (event: Record<string, unknown>) => {
      mocks.emitMissionOrchestrationObservation(event);
      actual.emitMissionOrchestrationObservation(event);
    },
  };
});

vi.mock('./mission-decision-lock.js', () => ({
  auditTaskDecisionDelivery: mocks.auditTaskDecisionDelivery,
  pinTaskDecisions: mocks.pinTaskDecisions,
  reconcileTaskDecisions: mocks.reconcileTaskDecisions,
  markTaskDecisionLockSuperseded: mocks.markTaskDecisionLockSuperseded,
  CUSTOMER_DECISION_BLOCKED_REASONS: [
    'awaiting_customer_decision',
    'customer_decision_check_failed',
    'customer_decision_tier_mismatch',
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
    mocks.packScope.value = undefined;
    {
      const provisioning = await vi.importActual<
        typeof import('../task/task-knowledge-provisioning.js')
      >('../task/task-knowledge-provisioning.js');
      mocks.provisionTaskKnowledge.mockImplementation(provisioning.provisionTaskKnowledge);
      const context = await vi.importActual<
        typeof import('./mission-orchestration-worker-part-context.js')
      >('./mission-orchestration-worker-part-context.js');
      mocks.recordMissionVisiblePrompt.mockImplementation(context.recordMissionVisiblePrompt);
      mocks.requestIndependentAcceptanceReview.mockImplementation(
        context.requestIndependentAcceptanceReview
      );
      mocks.notifyOperator.mockResolvedValue(undefined);
    }
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

  it('pins before the WorkItem import and reconciles before done; stale still completes', async () => {
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
    // The pin comes first so the import carries this round's pin-failure count.
    expect(order(mocks.pinTaskDecisions)).toBeLessThan(order(mocks.importExternalWorkItem));
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

  describe('confirmed customer decisions of a resumed task (CD-09 2026-10-25)', () => {
    const SENTINEL = 'ship-on-nov-first-SENTINEL';
    const CONSUMER = 'mission-MSN-CD09-WORKER.task-1';
    async function decisionValues() {
      const { ConfidentialTaskDecisionValues } =
        await import('../customer-decision/task-decision-values.js');
      return new ConfidentialTaskDecisionValues(
        { tenantSlug: 'acme-corp', caseId: 'case-a', consumer: CONSUMER },
        [
          {
            proposal_id: 'tp-0123456789abcdef',
            agenda_id: 'agd-test0001',
            entry_id: 'release',
            item: 'RELEASE',
            key: 'release.go',
            question: 'May we release?',
            decision_id: 'D-0001',
            value: { approved: true, note: SENTINEL },
          },
        ]
      );
    }
    async function useRealStores() {
      const actual = await vi.importActual<typeof import('../workforce/work-coordination.js')>(
        '../workforce/work-coordination.js'
      );
      mocks.importExternalWorkItem.mockImplementation(actual.importExternalWorkItem);
      mocks.updateWorkItem.mockImplementation(actual.updateWorkItem);
      mocks.findRelevantDistilledKnowledge.mockResolvedValue([]);
    }
    /** Every file under the shared runtime and the public mission directory that holds `needle`. */
    async function filesContaining(needle: string): Promise<string[]> {
      const { missionDir, pathResolver } = await import('../path-resolver.js');
      const { safeExistsSync, safeLstat, safeReadFile, safeReaddir } =
        await import('../secure-io.js');
      const nodePath = await import('node:path');
      const roots = [
        pathResolver.shared(''),
        nodePath.join(pathResolver.rootDir(), 'active', 'shared'),
        missionDir(MISSION_ID, 'public'),
      ];
      const hits: string[] = [];
      const walk = (dir: string) => {
        if (!safeExistsSync(dir)) return;
        for (const name of safeReaddir(dir)) {
          const file = nodePath.join(dir, name);
          // Other suites of the run create and remove files concurrently.
          let stat: ReturnType<typeof safeLstat>;
          try {
            stat = safeLstat(file);
          } catch {
            continue;
          }
          if (stat.isDirectory()) walk(file);
          else if (stat.isFile() && stat.size < 8 * 1024 * 1024) {
            let text = '';
            try {
              text = String(safeReadFile(file, { encoding: 'utf8' }));
            } catch {
              continue;
            }
            if (text.includes(needle)) hits.push(file);
          }
        }
      };
      for (const root of new Set(roots)) walk(root);
      return hits;
    }

    const confidentialScope = () => ({
      tenant_slug: 'acme-corp',
      tenant_id: 'acme-corp',
      mission_id: MISSION_ID,
      read_tiers: ['public', 'confidential'],
      write_tier: 'confidential',
      purpose: 'implementer',
      external_egress: 'deny',
    });
    async function storedWorkItems(): Promise<string> {
      const { listWorkItems } = await vi.importActual<
        typeof import('../workforce/work-coordination.js')
      >('../workforce/work-coordination.js');
      return JSON.stringify(listWorkItems({}));
    }

    it('a resumed task whose decision is no longer in force waits, undispatched (ids only)', async () => {
      await useRealStores();
      mocks.pinTaskDecisions.mockReturnValue({
        consumer: CONSUMER,
        pinned_count: 1,
        pinned: true,
        held: {
          case_id: 'case-a',
          tenant_slug: 'acme-corp',
          proposal_ids: ['tp-0123456789abcdef'],
          reason: 'decision_not_in_force',
        },
      });
      const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
      await dispatchMissionNextTasks(MISSION_ID);
      expect(mocks.route).not.toHaveBeenCalled();
      expect(mocks.provisionTaskKnowledge).not.toHaveBeenCalled();
      const blocked = mocks.updateWorkItem.mock.calls
        .map((call) => call[0] as { status?: string; metadata?: Record<string, unknown> })
        .find((update) => update.status === 'blocked');
      expect(blocked?.metadata).toMatchObject({
        blocked_reason: 'awaiting_customer_decision',
        customer_decision_hold: {
          status: 'awaiting',
          consumer: CONSUMER,
          case_id: 'case-a',
          hold_proposal_ids: ['tp-0123456789abcdef'],
          reason: 'decision_not_in_force',
        },
      });
      expect(mocks.auditTaskDecisionDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'task_decisions_withheld',
          reason: 'decision_not_in_force',
          proposalIds: ['tp-0123456789abcdef'],
        })
      );
    });

    it('a value restated in acceptance evidence and a reviewer gap reaches no WorkItem or notification', async () => {
      await useRealStores();
      const values = await decisionValues();
      mocks.packScope.value = confidentialScope();
      mocks.recordMissionVisiblePrompt.mockImplementation(() => undefined);
      mocks.pinTaskDecisions.mockReturnValue({
        consumer: CONSUMER,
        pinned_count: 1,
        pinned: true,
        decision_values: values,
      });
      // At the rework limit: the rejection blocks the task and notifies the operator.
      const { missionDir } = await import('../path-resolver.js');
      const { safeWriteFile } = await import('../secure-io.js');
      safeWriteFile(
        `${missionDir(MISSION_ID, 'public')}/NEXT_TASKS.json`,
        JSON.stringify([
          {
            task_id: 'task-1',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Implement the widget procedure',
            deliverable: 'deliverables/widget.md',
            rework_count: 5,
          },
        ])
      );
      mocks.requestIndependentAcceptanceReview.mockResolvedValue({
        approve: false,
        gaps: [`the release note must say ${SENTINEL}`],
        rationale: `rejected: ${SENTINEL} missing`,
        reviewerAgentId: 'independent-reviewer',
      });
      mocks.route.mockResolvedValueOnce({
        payload: {
          text: [
            '```task_result',
            JSON.stringify({
              summary: 'Released per D-0001.',
              artifacts: [],
              verification_done: ['checked'],
              gaps: [],
              needs: [],
              acceptance_evidence: [
                {
                  criterion: `release says ${SENTINEL}`,
                  status: 'passed',
                  evidence: `note reads ${SENTINEL}`,
                },
              ],
            }),
            '```',
          ].join('\n'),
        },
      });
      const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
      await dispatchMissionNextTasks(MISSION_ID);

      expect(mocks.requestIndependentAcceptanceReview).toHaveBeenCalled();
      // The reviewer, in the same confidential context, sees the result as written.
      expect(JSON.stringify(mocks.requestIndependentAcceptanceReview.mock.calls)).toContain(
        SENTINEL
      );
      const blocked = mocks.updateWorkItem.mock.calls
        .map((call) => call[0] as { status?: string; metadata?: Record<string, unknown> })
        .find((update) => update.status === 'blocked');
      expect(String(blocked?.metadata?.blocked_reason)).toContain('[customer decision D-0001]');
      expect(mocks.notifyOperator).toHaveBeenCalled();
      expect(
        JSON.stringify([
          mocks.updateWorkItem.mock.calls,
          mocks.notifyOperator.mock.calls,
          mocks.emitMissionTaskEvent.mock.calls,
        ])
      ).not.toContain(SENTINEL);
      expect(await storedWorkItems()).not.toContain(SENTINEL);
      expect(await filesContaining(SENTINEL)).toEqual([]);
      // The values went out, so the delivery is audited once.
      expect(mocks.auditTaskDecisionDelivery).toHaveBeenCalledTimes(1);
    });

    it('best-of-N: the losing candidate and the judge verdict are stored scrubbed', async () => {
      await useRealStores();
      const values = await decisionValues();
      mocks.packScope.value = confidentialScope();
      mocks.recordMissionVisiblePrompt.mockImplementation(() => undefined);
      mocks.pinTaskDecisions.mockReturnValue({
        consumer: CONSUMER,
        pinned_count: 1,
        pinned: true,
        decision_values: values,
      });
      mocks.reconcileTaskDecisions.mockReturnValue({
        consumer: CONSUMER,
        checked: 1,
        stale_count: 0,
        rework_work_item_ids: [],
      });
      const { missionDir } = await import('../path-resolver.js');
      const { safeWriteFile } = await import('../secure-io.js');
      safeWriteFile(
        `${missionDir(MISSION_ID, 'public')}/NEXT_TASKS.json`,
        JSON.stringify([
          {
            task_id: 'task-1',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Implement the widget procedure',
            deliverable: 'deliverables/widget.md',
            risk: 'high',
          },
        ])
      );
      mocks.route
        .mockResolvedValueOnce({
          payload: { text: makeTaskResultText({ summary: `A ships ${SENTINEL}` }) },
        })
        .mockResolvedValueOnce({
          payload: { text: makeTaskResultText({ summary: `B ships ${SENTINEL}` }) },
        })
        .mockResolvedValueOnce({
          payload: {
            text: JSON.stringify({
              winner: 'A',
              rationale: `A keeps ${SENTINEL}`,
              merge_hints: [`mention ${SENTINEL}`],
            }),
          },
        });
      const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
      await dispatchMissionNextTasks(MISSION_ID);
      expect(mocks.route).toHaveBeenCalledTimes(3);
      // The judge, in the same confidential context, sees the candidates as written.
      expect(
        String((mocks.route.mock.calls[2][0] as { payload: { text: string } }).payload.text)
      ).toContain(SENTINEL);
      expect(
        JSON.stringify([mocks.updateWorkItem.mock.calls, mocks.emitMissionTaskEvent.mock.calls])
      ).not.toContain(SENTINEL);
      expect(await filesContaining(SENTINEL)).toEqual([]);
    });

    const blockedUpdate = () =>
      mocks.updateWorkItem.mock.calls
        .map((call) => call[0] as { status?: string; metadata?: Record<string, unknown> })
        .find((update) => update.status === 'blocked');

    async function markHeldBefore(blockedReason: string): Promise<void> {
      const actual = await vi.importActual<typeof import('../workforce/work-coordination.js')>(
        '../workforce/work-coordination.js'
      );
      const created = actual.importExternalWorkItem({
        source: 'local',
        sourceRef: `mission:${MISSION_ID}:task-1`,
        title: 'task-1',
        description: 'task-1',
        status: 'ready',
        priority: 'normal',
        projectId: MISSION_ID,
      });
      actual.updateWorkItem({
        itemId: created.item_id,
        expectedVersion: created.version,
        status: 'blocked',
        metadata: { blocked_reason: blockedReason },
      });
    }

    it('a pin that keeps failing for a task not known to wait is left planned: retried once, not blocked, not run', async () => {
      await useRealStores();
      mocks.pinTaskDecisions.mockReturnValue({
        consumer: CONSUMER,
        pinned_count: 0,
        pinned: false,
        failed: { case_found: true, case_id: 'case-a' },
      });
      const warn = vi
        .spyOn((await import('../core.js')).logger, 'warn')
        .mockImplementation(() => undefined);
      const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
      await dispatchMissionNextTasks(MISSION_ID);
      expect(mocks.pinTaskDecisions).toHaveBeenCalledTimes(2);
      expect(mocks.route).not.toHaveBeenCalled();
      expect(blockedUpdate()).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/not dispatched — .*pin failed twice.* \| .*retried.* \| mission=/u)
      );
      warn.mockRestore();
    });

    describe('a pin that never succeeds is escalated (N = 3 rounds)', () => {
      const failing = () =>
        mocks.pinTaskDecisions.mockReturnValue({
          consumer: CONSUMER,
          pinned_count: 0,
          pinned: false,
          failed: { case_found: true, case_id: 'case-a' },
        });
      async function taskWorkItem() {
        const { listWorkItems } = await vi.importActual<
          typeof import('../workforce/work-coordination.js')
        >('../workforce/work-coordination.js');
        return listWorkItems({ source: 'local' }).find(
          (item) => item.source_ref === `mission:${MISSION_ID}:task-1`
        );
      }
      async function setTaskStatus(status: string) {
        const { missionDir } = await import('../path-resolver.js');
        const { safeReadFile, safeWriteFile } = await import('../secure-io.js');
        const file = `${missionDir(MISSION_ID, 'public')}/NEXT_TASKS.json`;
        const tasks = JSON.parse(String(safeReadFile(file, { encoding: 'utf8' }))) as Array<
          Record<string, unknown>
        >;
        safeWriteFile(file, JSON.stringify(tasks.map((task) => ({ ...task, status }))));
      }
      const pinFailures = async () =>
        (await taskWorkItem())?.metadata?.customer_decision_pin_failures as
          { count: number; first_failed_at: string; case_id?: string } | undefined;
      const ownerNotified = () =>
        mocks.emitMissionOrchestrationObservation.mock.calls.filter(
          (call) =>
            (call[0] as Record<string, unknown>).reason ===
            'customer_decision_pin_failed_repeatedly'
        );

      it('counts consecutive rounds on the WorkItem, blocks at the third and notifies once', async () => {
        await useRealStores();
        failing();
        const warn = vi
          .spyOn((await import('../core.js')).logger, 'warn')
          .mockImplementation(() => undefined);
        const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
        await dispatchMissionNextTasks(MISSION_ID);
        expect(await pinFailures()).toMatchObject({ count: 1, case_id: 'case-a' });
        const firstFailedAt = (await pinFailures())!.first_failed_at;
        await dispatchMissionNextTasks(MISSION_ID);
        expect(await pinFailures()).toMatchObject({ count: 2, first_failed_at: firstFailedAt });
        expect(blockedUpdate()).toBeUndefined();
        expect(mocks.addInboxEntry).not.toHaveBeenCalled();

        await dispatchMissionNextTasks(MISSION_ID);
        expect(mocks.route).not.toHaveBeenCalled();
        expect(blockedUpdate()?.metadata).toMatchObject({
          blocked_reason: 'customer_decision_check_failed',
          customer_decision_hold: { status: 'check_failed', reason: 'pin_failed_repeatedly' },
          customer_decision_pin_failures: { count: 3, first_failed_at: firstFailedAt },
        });
        expect(mocks.addInboxEntry).toHaveBeenCalledTimes(1);
        const entry = mocks.addInboxEntry.mock.calls[0][0] as Record<string, unknown>;
        expect(entry).toMatchObject({
          ifAbsent: true,
          missionId: MISSION_ID,
          kind: 'customer_decision_pin_failed',
        });
        expect(String(entry.entryId)).toMatch(/^INBOX-CDP-[0-9A-F]{16}$/u);
        expect(ownerNotified()).toHaveLength(1);
        expect(ownerNotified()[0][0]).toMatchObject({
          event_type: 'mission_owner_notified',
          task_id: 'task-1',
          pin_failure_count: 3,
          inbox_entry_id: entry.entryId,
        });

        // mission resume (after the held attempt's lease ended): the task runs
        // again, still failing — blocked, never re-notified.
        {
          const actual = await vi.importActual<typeof import('../workforce/work-coordination.js')>(
            '../workforce/work-coordination.js'
          );
          const held = (await taskWorkItem())!;
          if (held.lease_id) {
            actual.releaseWorkItem({
              itemId: held.item_id,
              leaseId: held.lease_id,
              actorPeerId: 'mission-orchestration-worker',
              nextStatus: 'blocked',
            });
          }
        }
        await setTaskStatus('planned');
        mocks.updateWorkItem.mockClear();
        await dispatchMissionNextTasks(MISSION_ID);
        expect(blockedUpdate()?.metadata).toMatchObject({
          customer_decision_hold: { reason: 'pin_failed_repeatedly' },
          customer_decision_pin_failures: { count: 4, first_failed_at: firstFailedAt },
        });
        expect(mocks.addInboxEntry).toHaveBeenCalledTimes(1);
        expect(ownerNotified()).toHaveLength(1);
        expect(mocks.route).not.toHaveBeenCalled();
        warn.mockRestore();
      });

      it('a successful pin or a mission without a case resets the count', async () => {
        await useRealStores();
        failing();
        const warn = vi
          .spyOn((await import('../core.js')).logger, 'warn')
          .mockImplementation(() => undefined);
        const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
        await dispatchMissionNextTasks(MISSION_ID);
        await dispatchMissionNextTasks(MISSION_ID);
        expect(await pinFailures()).toMatchObject({ count: 2 });
        // No decision case any more (null pin): the record is dropped, the task runs.
        mocks.pinTaskDecisions.mockReturnValue(null);
        mocks.route.mockResolvedValueOnce({
          payload: { text: makeTaskResultText({ summary: 'Completed the widget.' }) },
        });
        await dispatchMissionNextTasks(MISSION_ID);
        expect(mocks.route).toHaveBeenCalledTimes(1);
        expect(await pinFailures()).toBeUndefined();
        expect(mocks.addInboxEntry).not.toHaveBeenCalled();
        // Failing again starts a new streak.
        await setTaskStatus('planned');
        failing();
        await dispatchMissionNextTasks(MISSION_ID);
        expect(await pinFailures()).toMatchObject({ count: 1 });
        warn.mockRestore();
      });
    });

    it('a pin that recovers on the retry dispatches normally', async () => {
      await useRealStores();
      mocks.pinTaskDecisions
        .mockReturnValueOnce({
          consumer: CONSUMER,
          pinned_count: 0,
          pinned: false,
          failed: { case_found: true, case_id: 'case-a' },
        })
        .mockReturnValueOnce({ consumer: CONSUMER, pinned_count: 1, pinned: true });
      mocks.reconcileTaskDecisions.mockReturnValue({
        consumer: CONSUMER,
        checked: 1,
        stale_count: 0,
        rework_work_item_ids: [],
      });
      mocks.route.mockResolvedValueOnce({
        payload: { text: makeTaskResultText({ summary: 'Completed the widget.' }) },
      });
      const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
      await dispatchMissionNextTasks(MISSION_ID);
      expect(mocks.route).toHaveBeenCalledTimes(1);
    });

    it('a pin that keeps failing for a task blocked on a customer decision before blocks as a failed check', async () => {
      await useRealStores();
      await markHeldBefore('awaiting_customer_decision');
      mocks.pinTaskDecisions.mockReturnValue({
        consumer: CONSUMER,
        pinned_count: 0,
        pinned: false,
        failed: { case_found: false },
      });
      const warn = vi
        .spyOn((await import('../core.js')).logger, 'warn')
        .mockImplementation(() => undefined);
      const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
      await dispatchMissionNextTasks(MISSION_ID);
      expect(mocks.route).not.toHaveBeenCalled();
      expect(blockedUpdate()?.metadata).toMatchObject({
        blocked_reason: 'customer_decision_check_failed',
        customer_decision_hold: { status: 'check_failed', consumer: CONSUMER },
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/blocked — .*customer_decision_check_failed.* \| .* \| mission=/u)
      );
      warn.mockRestore();
    });

    it('a completed task whose decision changed is told, never silent: a count on a public mission, ids in the audit', async () => {
      await useRealStores();
      const { ConfidentialTaskDecisionValues } =
        await import('../customer-decision/task-decision-values.js');
      mocks.pinTaskDecisions.mockReturnValue({
        consumer: CONSUMER,
        pinned_count: 1,
        pinned: true,
        decision_values: new ConfidentialTaskDecisionValues(
          { tenantSlug: 'acme-corp', caseId: 'case-a', consumer: CONSUMER },
          [],
          [{ proposal_id: 'tp-0123456789abcdef', reason: 'changed_after_completion' }]
        ),
      });
      mocks.reconcileTaskDecisions.mockReturnValue({
        consumer: CONSUMER,
        checked: 1,
        stale_count: 0,
        rework_work_item_ids: [],
      });
      mocks.route.mockResolvedValueOnce({
        payload: { text: makeTaskResultText({ summary: 'Completed the widget.' }) },
      });
      // A public fixture mission: no confidential value, so no tier gate.
      const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
      await dispatchMissionNextTasks(MISSION_ID);
      expect(mocks.route).toHaveBeenCalledTimes(1);
      const prompt = String(
        (mocks.route.mock.calls[0][0] as { payload: { text: string } }).payload.text
      );
      // A public mission: the gate would refuse values, so the note is a count, no proposal id.
      expect(prompt).toContain(
        "1 of this task's customer decisions changed after it completed or are no longer recorded, and are not confirmed; do not assume their values"
      );
      expect(prompt).not.toMatch(/tp-[a-f0-9]/u);
      expect(blockedUpdate()).toBeUndefined();
      expect(mocks.auditTaskDecisionDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'task_decisions_delivered',
          reason: 'changed_after_completion',
          proposalIds: ['tp-0123456789abcdef'],
        })
      );
    });

    it('an unresolvable hold blocks with its own reason and a next step that can be done', async () => {
      await useRealStores();
      mocks.pinTaskDecisions.mockReturnValue({
        consumer: CONSUMER,
        pinned_count: 1,
        pinned: true,
        held: {
          case_id: 'case-a',
          tenant_slug: 'acme-corp',
          proposal_ids: ['tp-0123456789abcdef'],
          reason: 'customer_decision_unresolvable',
        },
      });
      const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
      await dispatchMissionNextTasks(MISSION_ID);
      expect(mocks.route).not.toHaveBeenCalled();
      const metadata = blockedUpdate()?.metadata;
      expect(metadata).toMatchObject({
        blocked_reason: 'customer_decision_unresolvable',
        customer_decision_hold: {
          status: 'unresolvable',
          reason: 'customer_decision_unresolvable',
        },
      });
      const next = String(
        (metadata?.customer_decision_hold as { next?: string } | undefined)?.next
      );
      // The two ways out: ask the question again, or replace the task (human-approved).
      expect(next).toMatch(/customer-decision draft --from-tasks --reask/u);
      expect(next).toMatch(
        new RegExp(`pnpm mission supersede-task ${MISSION_ID} task-1 --by <new_task_id>`, 'u')
      );
      expect(String((metadata?.customer_decision_hold as { next?: string }).next)).not.toMatch(
        /customer-decision confirm/u
      );
    });

    it('the gate sees the result as written: a value in an artifact path and a criterion still passes', async () => {
      await useRealStores();
      const values = await decisionValues();
      mocks.packScope.value = confidentialScope();
      mocks.recordMissionVisiblePrompt.mockImplementation(() => undefined);
      mocks.pinTaskDecisions.mockReturnValue({
        consumer: CONSUMER,
        pinned_count: 1,
        pinned: true,
        decision_values: values,
      });
      mocks.reconcileTaskDecisions.mockReturnValue({
        consumer: CONSUMER,
        checked: 1,
        stale_count: 0,
        rework_work_item_ids: [],
      });
      const { missionDir } = await import('../path-resolver.js');
      const { safeWriteFile } = await import('../secure-io.js');
      const missionPath = missionDir(MISSION_ID, 'public');
      safeWriteFile(`${missionPath}/deliverables/${SENTINEL}.md`, '# release');
      safeWriteFile(
        `${missionPath}/NEXT_TASKS.json`,
        JSON.stringify([
          {
            task_id: 'task-1',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Implement the widget procedure',
            deliverable: 'deliverables/widget.md',
            acceptance_criteria: [`release note names ${SENTINEL}`],
          },
        ])
      );
      mocks.route.mockResolvedValueOnce({
        payload: {
          text: [
            '```task_result',
            JSON.stringify({
              summary: `Done: release note names ${SENTINEL}.`,
              artifacts: [{ path: `deliverables/${SENTINEL}.md`, kind: 'document' }],
              verification_done: ['checked the note'],
              gaps: [],
              needs: [],
            }),
            '```',
          ].join('\n'),
        },
      });
      const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
      await dispatchMissionNextTasks(MISSION_ID);
      const done = mocks.updateWorkItem.mock.calls
        .map((call) => call[0] as { status?: string; metadata?: Record<string, unknown> })
        .find((update) => update.status === 'done');
      expect(done).toBeDefined();
      // The worker's words are stored scrubbed (the criterion is the task's own text).
      expect(String(done?.metadata?.summary)).toBe(
        'Done: release note names [customer decision D-0001].'
      );
    });

    it('a route that fails after the prompt went out is audited as attempted (ids only)', async () => {
      await useRealStores();
      const values = await decisionValues();
      mocks.packScope.value = confidentialScope();
      mocks.recordMissionVisiblePrompt.mockImplementation(() => undefined);
      mocks.pinTaskDecisions.mockReturnValue({
        consumer: CONSUMER,
        pinned_count: 1,
        pinned: true,
        decision_values: values,
      });
      vi.spyOn((await import('../core.js')).logger, 'error').mockImplementation(() => undefined);
      mocks.route.mockRejectedValueOnce(new Error('connection reset'));
      const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
      await dispatchMissionNextTasks(MISSION_ID);
      expect(mocks.auditTaskDecisionDelivery).toHaveBeenCalledTimes(1);
      expect(mocks.auditTaskDecisionDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'task_decisions_delivered', reason: 'attempted' })
      );
    });

    it('an agent that is busy got nothing: no delivery is audited', async () => {
      await useRealStores();
      const values = await decisionValues();
      mocks.packScope.value = confidentialScope();
      mocks.recordMissionVisiblePrompt.mockImplementation(() => undefined);
      mocks.pinTaskDecisions.mockReturnValue({
        consumer: CONSUMER,
        pinned_count: 1,
        pinned: true,
        decision_values: values,
      });
      const { AgentBusyError } = await import('../mesh/a2a-bridge.js');
      mocks.route.mockRejectedValueOnce(new AgentBusyError('implementation-architect is busy'));
      const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
      await dispatchMissionNextTasks(MISSION_ID);
      expect(mocks.route).toHaveBeenCalled();
      expect(mocks.auditTaskDecisionDelivery).not.toHaveBeenCalled();
    });

    it('a public mission: the WorkItem is blocked as a tier mismatch and nothing is sent', async () => {
      await useRealStores();
      const values = await decisionValues();
      mocks.pinTaskDecisions.mockReturnValue({
        consumer: CONSUMER,
        pinned_count: 1,
        pinned: true,
        decision_values: values,
      });
      const warn = vi
        .spyOn((await import('../core.js')).logger, 'warn')
        .mockImplementation(() => undefined);
      const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
      await dispatchMissionNextTasks(MISSION_ID);

      expect(mocks.route).not.toHaveBeenCalled();
      expect(mocks.reconcileTaskDecisions).not.toHaveBeenCalled();
      const blocked = mocks.updateWorkItem.mock.calls
        .map((call) => call[0] as { status?: string; metadata?: Record<string, unknown> })
        .find((update) => update.status === 'blocked');
      expect(blocked?.metadata).toMatchObject({
        blocked_reason: 'customer_decision_tier_mismatch',
        customer_decision_hold: {
          status: 'tier_mismatch',
          consumer: CONSUMER,
          case_id: 'case-a',
          decision_ids: ['D-0001'],
          reason: 'mission_tier_public',
        },
      });
      expect(mocks.auditTaskDecisionDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'task_decisions_withheld',
          reason: 'mission_tier_public',
          missionId: MISSION_ID,
          taskId: 'task-1',
        })
      );
      expect(
        JSON.stringify([
          mocks.updateWorkItem.mock.calls,
          mocks.emitMissionTaskEvent.mock.calls,
          mocks.recordMissionVisiblePrompt.mock.calls,
          warn.mock.calls,
        ])
      ).not.toMatch(/SENTINEL|release\.go|May we release/u);
      expect(await filesContaining(SENTINEL)).toEqual([]);
      warn.mockRestore();
    });

    it('a confidential same-tenant scope: the prompt carries the value, the WorkItem summary does not', async () => {
      await useRealStores();
      const values = await decisionValues();
      mocks.packScope.value = {
        tenant_slug: 'acme-corp',
        tenant_id: 'acme-corp',
        mission_id: MISSION_ID,
        read_tiers: ['public', 'confidential'],
        write_tier: 'confidential',
        purpose: 'implementer',
        external_egress: 'deny',
      };
      // The visibility ledger would place the record by the (fixture) scope's tier.
      mocks.recordMissionVisiblePrompt.mockImplementation(() => undefined);
      mocks.pinTaskDecisions.mockReturnValue({
        consumer: CONSUMER,
        pinned_count: 1,
        pinned: true,
        decision_values: values,
      });
      mocks.reconcileTaskDecisions.mockReturnValue({
        consumer: CONSUMER,
        checked: 1,
        stale_count: 0,
        rework_work_item_ids: [],
      });
      mocks.route.mockResolvedValueOnce({
        payload: {
          text: makeTaskResultText({
            summary: `Released as decided (${SENTINEL}) per D-0001.`,
          }),
        },
      });
      const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
      await dispatchMissionNextTasks(MISSION_ID);

      expect(mocks.route).toHaveBeenCalledTimes(1);
      const prompt = String(
        (mocks.route.mock.calls[0][0] as { payload: { text: string } }).payload.text
      );
      expect(prompt).toContain(SENTINEL);
      expect(prompt.slice(0, 240)).not.toContain(SENTINEL);
      expect(prompt.indexOf('## Confirmed customer decisions (confidential')).toBeGreaterThan(
        prompt.indexOf('Mission context pack') >= 0 ? prompt.indexOf('Mission context pack') : 0
      );
      // Nothing in the envelope besides the prompt text carries it.
      const envelope = mocks.route.mock.calls[0][0] as { payload: Record<string, unknown> };
      expect(JSON.stringify({ ...envelope.payload, text: undefined })).not.toContain(SENTINEL);
      const done = mocks.updateWorkItem.mock.calls
        .map((call) => call[0] as { status?: string; metadata?: Record<string, unknown> })
        .find((update) => update.status === 'done');
      expect(done?.metadata?.summary).toBe(
        'Released as decided ([customer decision D-0001]) per D-0001.'
      );
      expect(mocks.auditTaskDecisionDelivery).toHaveBeenCalledTimes(1);
      expect(mocks.auditTaskDecisionDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'task_decisions_delivered', taskId: 'task-1' })
      );
      // The prompt-visibility record names the decisions by id (metadata only).
      expect(mocks.recordMissionVisiblePrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          form: 'customer_decision_values',
          knowledgeRefs: [{ path: 'customer-decision:case-a#D-0001' }],
        })
      );
      expect(
        JSON.stringify([mocks.updateWorkItem.mock.calls, mocks.emitMissionTaskEvent.mock.calls])
      ).not.toContain(SENTINEL);
      expect(await filesContaining(SENTINEL)).toEqual([]);
    });
  });

  it('an unresolvable task is superseded (human-approved) and the mission finishes on its replacement', async () => {
    const actual = await vi.importActual<typeof import('../workforce/work-coordination.js')>(
      '../workforce/work-coordination.js'
    );
    mocks.importExternalWorkItem.mockImplementation(actual.importExternalWorkItem);
    mocks.updateWorkItem.mockImplementation(actual.updateWorkItem);
    mocks.findRelevantDistilledKnowledge.mockResolvedValue([]);
    const consumer = 'mission-MSN-CD09-WORKER.task-1';
    mocks.pinTaskDecisions.mockImplementation((input: { taskId: string }) =>
      input.taskId === 'task-1'
        ? {
            consumer,
            pinned_count: 1,
            pinned: true,
            held: {
              case_id: 'case-a',
              tenant_slug: 'acme-corp',
              proposal_ids: ['tp-0123456789abcdef'],
              reason: 'customer_decision_unresolvable',
            },
          }
        : null
    );
    mocks.markTaskDecisionLockSuperseded.mockReturnValue({
      case_found: true,
      consumer,
      case_id: 'case-a',
      marked: true,
    });
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
    await dispatchMissionNextTasks(MISSION_ID);
    expect(mocks.route).not.toHaveBeenCalled();

    const { missionDir } = await import('../path-resolver.js');
    const { safeReadFile, safeWriteFile, safeRmSync } = await import('../secure-io.js');
    const missionPath = missionDir(MISSION_ID, 'public');
    const tasks = JSON.parse(
      String(safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }))
    ) as Array<Record<string, unknown>>;
    expect(tasks.find((task) => task.task_id === 'task-1')?.status).toBe('blocked');
    // The operator adds the replacement task, then supersedes the held one.
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          ...tasks,
          {
            task_id: 'task-1-v2',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Implement the widget without the withdrawn decision',
            deliverable: 'deliverables/widget.md',
            dependencies: [],
          },
        ],
        null,
        2
      )
    );
    const { approvalEventLogicalPath, approvalRequestLogicalPath, decideApprovalRequest } =
      await import('../governance/approval-store.js');
    const {
      createMissionTaskSupersedeApprovalRequest,
      MISSION_TASK_SUPERSEDE_APPROVAL_CHANNEL,
      supersedeMissionTask,
    } = await import('./mission-task-supersede.js');
    const supersede = {
      missionId: MISSION_ID,
      taskId: 'task-1',
      byTaskId: 'task-1-v2',
      reason: 'The agenda was withdrawn; the widget ships without that decision.',
    };
    const request = createMissionTaskSupersedeApprovalRequest({
      ...supersede,
      requestedBy: 'cd09-worker-operator',
    });
    try {
      decideApprovalRequest('mission_controller', {
        channel: request.channel,
        storageChannel: request.storageChannel,
        requestId: request.id,
        decision: 'approved',
        decidedBy: 'human-supersede-approver',
        decidedByRole: 'sovereign',
        authMethod: 'manual',
        decidedByType: 'human',
        authenticated: true,
        payloadHash: request.accountability?.payloadHash,
        effectBinding: request.accountability?.effectBinding,
      });
      const applied = await supersedeMissionTask({ ...supersede, approvalRequestId: request.id });
      expect(applied).toMatchObject({
        status: 'applied',
        customer_decision_lock: { marked: true },
      });
      expect(mocks.markTaskDecisionLockSuperseded).toHaveBeenCalledWith({
        missionId: MISSION_ID,
        taskId: 'task-1',
        byTaskId: 'task-1-v2',
        approvalRequestId: request.id,
      });

      const { evaluateMissionFinishExitGate } = await import('./mission-lifecycle.js');
      expect(evaluateMissionFinishExitGate(missionPath)).toMatchObject({
        ok: false,
        pendingTasks: ['task-1-v2'],
      });
      mocks.reconcileTaskDecisions.mockReturnValue({
        checked: 0,
        stale_count: 0,
        rework_work_item_ids: [],
      });
      mocks.route.mockResolvedValueOnce({
        payload: { text: makeTaskResultText({ summary: 'Completed the widget.' }) },
      });
      await dispatchMissionNextTasks(MISSION_ID);
      // Only the replacement ran; the superseded task was never dispatched again.
      expect(mocks.route).toHaveBeenCalledTimes(1);
      expect(
        mocks.pinTaskDecisions.mock.calls.filter(
          (call) => (call[0] as { taskId: string }).taskId === 'task-1'
        ).length
      ).toBe(1);
      const after = JSON.parse(
        String(safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }))
      ) as Array<Record<string, unknown>>;
      expect(after.find((task) => task.task_id === 'task-1')?.status).toBe('superseded');
      expect(evaluateMissionFinishExitGate(missionPath)).toEqual({ ok: true, pendingTasks: [] });
    } finally {
      safeRmSync(approvalRequestLogicalPath(MISSION_TASK_SUPERSEDE_APPROVAL_CHANNEL, request.id), {
        force: true,
      });
      safeRmSync(approvalEventLogicalPath(MISSION_TASK_SUPERSEDE_APPROVAL_CHANNEL), {
        force: true,
      });
    }
  });

  it('never starts a dependent of a superseded task (the dependency is not satisfied)', async () => {
    const actual = await vi.importActual<typeof import('../workforce/work-coordination.js')>(
      '../workforce/work-coordination.js'
    );
    mocks.importExternalWorkItem.mockImplementation(actual.importExternalWorkItem);
    mocks.updateWorkItem.mockImplementation(actual.updateWorkItem);
    mocks.findRelevantDistilledKnowledge.mockResolvedValue([]);
    mocks.pinTaskDecisions.mockReturnValue(null);
    const { missionDir } = await import('../path-resolver.js');
    const { safeWriteFile } = await import('../secure-io.js');
    safeWriteFile(
      `${missionDir(MISSION_ID, 'public')}/NEXT_TASKS.json`,
      JSON.stringify([
        {
          task_id: 'task-old',
          status: 'superseded',
          assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
          description: 'Replaced task',
          deliverable: 'deliverables/widget.md',
          dependencies: [],
        },
        {
          task_id: 'task-1',
          status: 'planned',
          assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
          description: 'A dependent that was not rewritten',
          deliverable: 'deliverables/widget.md',
          dependencies: ['task-old'],
        },
      ])
    );
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
    await dispatchMissionNextTasks(MISSION_ID);
    expect(mocks.route).not.toHaveBeenCalled();
  });

  it("carries a dependent's supersede rewrite note onto its re-imported WorkItem", async () => {
    const actual = await vi.importActual<typeof import('../workforce/work-coordination.js')>(
      '../workforce/work-coordination.js'
    );
    mocks.importExternalWorkItem.mockImplementation(actual.importExternalWorkItem);
    mocks.updateWorkItem.mockImplementation(actual.updateWorkItem);
    mocks.findRelevantDistilledKnowledge.mockResolvedValue([]);
    mocks.pinTaskDecisions.mockReturnValue({
      consumer: 'mission-MSN-CD09-WORKER.task-1',
      pinned_count: 1,
      pinned: false,
      failed: { case_found: true, case_id: 'case-a' },
    });
    const rewrite = { from: 'task-old', to: 'task-new', at: '2026-10-26T00:00:00.000Z' };
    const { missionDir } = await import('../path-resolver.js');
    const { safeWriteFile } = await import('../secure-io.js');
    safeWriteFile(
      `${missionDir(MISSION_ID, 'public')}/NEXT_TASKS.json`,
      JSON.stringify([
        {
          task_id: 'task-1',
          status: 'planned',
          assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
          description: 'Implement the widget procedure',
          deliverable: 'deliverables/widget.md',
          dependencies: [],
          dependencies_rewritten_from: [rewrite],
        },
      ])
    );
    const warn = vi
      .spyOn((await import('../core.js')).logger, 'warn')
      .mockImplementation(() => undefined);
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
    await dispatchMissionNextTasks(MISSION_ID);
    const imported = mocks.importExternalWorkItem.mock.calls[0][0] as {
      metadata?: Record<string, unknown>;
    };
    expect(imported.metadata?.dependencies_rewritten_from).toEqual([rewrite]);
    warn.mockRestore();
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
