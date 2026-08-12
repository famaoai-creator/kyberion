import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NI-03 acceptance: mission task dispatch originates the delegation chain
// (orchestrator root → dispatched worker), embeds it in the task-contract
// payload (`context.delegation_chain`) AND the A2A envelope header
// (`delegation_chain`, compact-serialized), stamps `onBehalfOf` (= chain
// root actor) on the mission_task_dispatch trace, and forwards the chain to
// the execution ledger via the participant_context_resolved event payload.
//
// Hermetic technique copied from mission-orchestration-worker.kp05-trace.test.ts
// (mocked A2A route + team plan + context pack; trace persisted into a
// KYBERION_MISSION_TASK_TRACE_DIR override).

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
  resolveMissionContextPack: vi.fn(),
}));

function makeTaskResultText(summary: string): string {
  return [
    '```task_result',
    JSON.stringify({
      summary,
      artifacts: [{ path: 'deliverables/presentation.html', kind: 'html' }],
      verification_done: ['Confirmed the deliverable path.'],
      gaps: [],
      needs: [],
    }),
    '```',
  ].join('\n');
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

vi.mock('./mission-context-pack.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mission-context-pack.js')>();
  return {
    ...actual,
    resolveMissionContextPack: mocks.resolveMissionContextPack,
  };
});

const MISSION_ID = `MSN-NI03-CHAIN-${process.pid}`;

describe('mission-orchestration-worker NI-03 delegation chain', { timeout: 60_000 }, () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    process.env.MISSION_ROLE = 'mission_controller';
    const { missionDir, pathResolver } = await import('./path-resolver.js');
    process.env.KYBERION_TEST_OBSERVABILITY_DIR = pathResolver.shared(
      `tmp/vitest-observability/ni03-chain-${process.pid}`
    );
    process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR = pathResolver.shared(
      `tmp/vitest-knowledge-delivery/ni03-chain-${process.pid}`
    );
    process.env.KYBERION_KNOWLEDGE_USAGE_PATH = pathResolver.shared(
      `tmp/vitest-knowledge-usage/ni03-chain-${process.pid}/usage.json`
    );
    process.env.KYBERION_MEMORY_QUEUE_PATH = pathResolver.shared(
      `tmp/vitest-memory-queue/ni03-chain-${process.pid}/promotion-queue.jsonl`
    );
    process.env.KYBERION_MISSION_TASK_TRACE_DIR = pathResolver.shared(
      `tmp/vitest-mission-task-trace/ni03-chain-${process.pid}`
    );
    {
      const { safeMkdir: mkdirForQueue } = await import('./secure-io.js');
      const nodePathModule = await import('node:path');
      mkdirForQueue(nodePathModule.dirname(process.env.KYBERION_MEMORY_QUEUE_PATH), {
        recursive: true,
      });
    }
    const { clearWorkCoordinationStore, setWorkCoordinationNamespace } =
      await import('./work-coordination.js');
    const { safeMkdir, safeWriteFile } = await import('./secure-io.js');
    setWorkCoordinationNamespace('mission-orchestration-worker-ni03-chain-test');
    clearWorkCoordinationStore();
    const missionPath = missionDir(MISSION_ID, 'public');
    safeMkdir(missionPath, { recursive: true });
    safeMkdir(`${missionPath}/deliverables`, { recursive: true });
    safeWriteFile(`${missionPath}/deliverables/presentation.html`, '<html>presentation</html>');
    safeWriteFile(
      `${missionPath}/mission-state.json`,
      JSON.stringify(
        {
          mission_id: MISSION_ID,
          mission_type: 'development',
          tier: 'public',
          status: 'active',
          execution_mode: 'local',
          relationships: {
            project: {
              project_id: MISSION_ID,
              project_path: `active/projects/public/shared/${MISSION_ID}/project-os`,
              relationship_type: 'supports',
              affected_artifacts: [],
              gate_impact: 'informational',
              traceability_refs: [],
              note: 'NI-03 chain test fixture',
            },
          },
          priority: 3,
          assigned_persona: 'worker',
          confidence_score: 1,
          git: {
            branch: 'mission/ni03-chain-fixture',
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
      `${missionPath}/TASK_BOARD.md`,
      [
        `# TASK_BOARD: ${MISSION_ID}`,
        '',
        '## Status: Planning Ready',
        '',
        '### 🛠️ Execution Phase',
        '- [x] Step 1: Research and Strategy',
        '- [ ] Step 2: Implementation',
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
            description: 'Implement the deck',
            deliverable: 'deliverables/presentation.html',
          },
        ],
        null,
        2
      )
    );

    mocks.ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue({
      runtime_plan: { mission_id: MISSION_ID, assignments: [] },
    });
    mocks.resolveMissionTeamPlan.mockReturnValue({
      mission_id: MISSION_ID,
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
      payload: { text: makeTaskResultText('Accepted the task and produced the artifact.') },
    });

    const { buildMissionContextPack } = await import('./mission-context-pack.js');
    const pack = buildMissionContextPack({
      contextPackId: `ni03-chain-fixture-${process.pid}`,
      missionPath,
      missionState: {
        mission_id: MISSION_ID,
        tier: 'public',
        status: 'active',
        execution_mode: 'local',
        priority: 3,
        assigned_persona: 'worker',
        confidence_score: 1,
        git: { branch: 'main', start_commit: 'a', latest_commit: 'a', checkpoints: [] },
        history: [],
      },
      teamRole: 'implementer',
      recipientKind: 'agent',
      assigneePeerId: 'implementation-architect',
      workItem: {
        item_id: 'task-1',
        title: 'Implement the deck',
        description: 'Implement the deck',
        status: 'ready',
        priority: 'normal',
        source: 'local',
        source_ref: `mission:${MISSION_ID}:task-1`,
        project_id: MISSION_ID,
        labels: [],
        dependencies: [],
        version: 1,
        created_at: '2026-07-25T00:00:00.000Z',
        updated_at: '2026-07-25T00:00:00.000Z',
      },
      knowledgeHints: [],
    });
    mocks.resolveMissionContextPack.mockResolvedValue(pack);
  });

  afterEach(async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { clearWorkCoordinationStore, clearWorkCoordinationNamespace } =
      await import('./work-coordination.js');
    const { safeExistsSync, safeRmSync } = await import('./secure-io.js');
    const missionPath = missionDir(MISSION_ID, 'public');
    if (safeExistsSync(missionPath)) safeRmSync(missionPath);
    // The mission fixture declares a project_path, so dispatch materialises a
    // project workspace next to the mission. Removing only the mission left it
    // behind, and every run seeded a fresh unregistered workspace that
    // check:entity-governance then reported as drift (EG-14).
    const { pathResolver } = await import('./path-resolver.js');
    const projectWorkspace = pathResolver.rootResolve(
      `active/projects/public/shared/${MISSION_ID}`
    );
    if (safeExistsSync(projectWorkspace)) {
      safeRmSync(projectWorkspace, { recursive: true, force: true });
    }
    for (const envVar of [
      'KYBERION_TEST_OBSERVABILITY_DIR',
      'KYBERION_KNOWLEDGE_DELIVERY_DIR',
      'KYBERION_KNOWLEDGE_USAGE_PATH',
      'KYBERION_MEMORY_QUEUE_PATH',
      'KYBERION_MISSION_TASK_TRACE_DIR',
    ]) {
      const dir = process.env[envVar];
      if (dir && safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
      delete process.env[envVar];
    }
    clearWorkCoordinationStore();
    clearWorkCoordinationNamespace();
  });

  async function readMissionTaskDispatchTraces(): Promise<
    Array<{ metadata?: Record<string, unknown>; rootSpan: { name: string } }>
  > {
    const { pathResolver } = await import('./path-resolver.js');
    const { safeExistsSync, safeReaddir, safeReadFile } = await import('./secure-io.js');
    const dir = pathResolver.rootResolve(process.env.KYBERION_MISSION_TASK_TRACE_DIR!);
    if (!safeExistsSync(dir)) return [];
    const traces: Array<{ metadata?: Record<string, unknown>; rootSpan: { name: string } }> = [];
    for (const file of safeReaddir(dir)) {
      if (!file.startsWith('traces-') || !file.endsWith('.jsonl')) continue;
      const content = safeReadFile(`${dir}/${file}`, { encoding: 'utf8' }) as string;
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        traces.push(JSON.parse(line));
      }
    }
    return traces.filter((t) => t.rootSpan?.name === 'mission_task_dispatch');
  }

  it('originates the chain at dispatch: contract payload + signed-header field + trace onBehalfOf + ledger event', async () => {
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
    const { parseDelegationChain } = await import('./delegation-chain.js');
    const { validateA2ATaskContract } = await import('./a2a-task-contract.js');

    const dispatched = await dispatchMissionNextTasks(MISSION_ID);
    expect(dispatched).toEqual([
      { task_id: 'task-1', team_role: 'implementer', agent_id: 'implementation-architect' },
    ]);

    // (a) chain embedded in the task-contract payload handed to the worker.
    expect(mocks.route).toHaveBeenCalledTimes(1);
    const envelope = mocks.route.mock.calls[0][0];
    const payloadChain = envelope.payload?.context?.delegation_chain;
    expect(Array.isArray(payloadChain)).toBe(true);
    expect(payloadChain).toHaveLength(2);
    // Root-first: orchestrator → dispatched worker.
    expect(payloadChain[0]).toMatchObject({
      team_role: 'orchestrator',
      granted_scope: {},
    });
    expect(String(payloadChain[0].actor)).toMatch(
      /^kyberion:\/\/agent\/[a-z][a-z0-9-]*\/mission-orchestrator$/
    );
    expect(payloadChain[1]).toMatchObject({
      team_role: 'implementer',
      granted_scope: { capability_tier: 'implementer' },
    });
    expect(String(payloadChain[1].actor)).toMatch(
      /^kyberion:\/\/agent\/[a-z][a-z0-9-]*\/implementation-architect$/
    );
    // The chain-carrying payload still satisfies the strict A2A task contract.
    expect(validateA2ATaskContract(envelope.payload).valid).toBe(true);

    // The A2A header carries the same chain, compact-serialized (HMAC-covered
    // once the envelope is signed — canonicalA2AEnvelopeContent spreads the
    // whole header).
    const headerChain = parseDelegationChain(envelope.header?.delegation_chain);
    expect(headerChain).toEqual(payloadChain);

    // (b) trace metadata: onBehalfOf = the chain's root actor.
    const traces = await readMissionTaskDispatchTraces();
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0].metadata?.onBehalfOf).toBe(payloadChain[0].actor);

    // (c) execution-ledger propagation: the participant_context_resolved
    // event payload carries the chain; mission-task-events forwards event
    // payloads to appendMissionExecutionLedgerEntry, which promotes it to the
    // first-class delegation_chain ledger column (covered by
    // mission-team-binding.ni03-delegation.test.ts).
    const participantEvent = mocks.emitMissionTaskEvent.mock.calls
      .map((call) => call[0])
      .find((event) => event.event_type === 'participant_context_resolved');
    expect(participantEvent?.payload?.delegation_chain).toEqual(payloadChain);
  });
});
