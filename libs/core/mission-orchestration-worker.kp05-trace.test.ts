import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// KP-05 acceptance-1 follow-up: mission task dispatch (single-shot via
// dispatchPlannedMissionTaskCore) opens a `mission_task_dispatch` TraceContext
// span and attaches `deliveredKnowledgeRefs` (provisionTaskKnowledge's return)
// to it. This suite proves the span lands with non-empty `knowledgeRefs` and
// that a tracing failure never affects dispatch.
//
// Same hermetic technique as mission-orchestration-worker.goal-driven.test.ts's
// "KP-01: goal-driven dispatch context-pack provisioning" describe block:
// mock `resolveMissionContextPack` to a deterministic fixture pack (built via
// the real `buildMissionContextPack`) so `knowledge_hints` — and therefore
// `deliveredKnowledgeRefs` — are non-empty and predictable, without depending
// on real corpus search. Everything else reuses
// mission-orchestration-worker.test.ts's proven two-task dispatch fixture.

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
  // Mutable flag (not a vi.fn(), so vi.resetAllMocks() leaves it alone) —
  // flips the mocked persistTrace between "call straight through" and
  // "simulate a tracing-store failure" per test.
  persistTraceShouldThrow: { value: false },
}));

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

// Real `persistTrace` by default; `persistTraceShouldThrow.value = true` in
// the failure test simulates the persistence seam breaking. This is the only
// seam this task adds beyond `persistTrace`'s existing `opts.dir` override
// (used via KYBERION_MISSION_TASK_TRACE_DIR below) — no new tracer invented.
vi.mock('./src/trace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./src/trace.js')>();
  return {
    ...actual,
    persistTrace: (...args: Parameters<typeof actual.persistTrace>) => {
      if (mocks.persistTraceShouldThrow.value) {
        throw new Error('KP-05 test: simulated trace persistence failure');
      }
      return actual.persistTrace(...args);
    },
  };
});

const MISSION_ID = `MSN-KP05-TRACE-${process.pid}`;
const KNOWLEDGE_HINT_PATH = 'knowledge/product/governance/kp05-trace-fixture-hint.md';

describe('mission-orchestration-worker KP-05 dispatch tracing', { timeout: 60_000 }, () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.persistTraceShouldThrow.value = false;
    process.env.MISSION_ROLE = 'mission_controller';
    const { missionDir, pathResolver } = await import('./path-resolver.js');
    process.env.KYBERION_TEST_OBSERVABILITY_DIR = pathResolver.shared(
      `tmp/vitest-observability/kp05-trace-${process.pid}`
    );
    process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR = pathResolver.shared(
      `tmp/vitest-knowledge-delivery/kp05-trace-${process.pid}`
    );
    process.env.KYBERION_KNOWLEDGE_USAGE_PATH = pathResolver.shared(
      `tmp/vitest-knowledge-usage/kp05-trace-${process.pid}/usage.json`
    );
    process.env.KYBERION_MEMORY_QUEUE_PATH = pathResolver.shared(
      `tmp/vitest-memory-queue/kp05-trace-${process.pid}/promotion-queue.jsonl`
    );
    // The seam under test: dispatch traces persist here instead of the real
    // active/shared/logs/traces/ store.
    process.env.KYBERION_MISSION_TASK_TRACE_DIR = pathResolver.shared(
      `tmp/vitest-mission-task-trace/kp05-trace-${process.pid}`
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
    setWorkCoordinationNamespace('mission-orchestration-worker-kp05-trace-test');
    clearWorkCoordinationStore();
    const missionPath = missionDir(MISSION_ID, 'public');
    safeMkdir(missionPath, { recursive: true });
    safeMkdir(`${missionPath}/deliverables`, { recursive: true });
    safeWriteFile(`${missionPath}/deliverables/presentation.html`, '<html>presentation</html>');
    safeWriteFile(`${missionPath}/deliverables/REVIEW-task-1.md`, '# review task 1');
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
              note: 'KP-05 trace test fixture',
            },
          },
          priority: 3,
          assigned_persona: 'worker',
          confidence_score: 1,
          git: {
            branch: 'mission/kp05-trace-fixture',
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
      payload: {
        text: makeTaskResultText({
          summary: 'Accepted the task and recorded the requested artifact.',
          artifacts: [{ path: 'deliverables/presentation.html', kind: 'html' }],
          verification_done: ['Confirmed the deliverable path.'],
        }),
      },
    });

    const { buildMissionContextPack } = await import('./mission-context-pack.js');
    const pack = buildMissionContextPack({
      contextPackId: `kp05-trace-fixture-${process.pid}`,
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
      knowledgeHints: [
        {
          path: KNOWLEDGE_HINT_PATH,
          title: 'KP-05 Trace Fixture Hint',
          excerpt: 'Deterministic hint content the KP-05 dispatch trace test must surface.',
          tags: ['kp-05'],
          score: 0.42,
        },
      ],
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
    Array<{
      rootSpan: {
        name: string;
        knowledgeRefs: string[];
        attributes?: Record<string, string | number | boolean>;
        events: Array<{ name: string; attributes?: Record<string, unknown> }>;
      };
    }>
  > {
    const { pathResolver } = await import('./path-resolver.js');
    const { safeExistsSync, safeReaddir, safeReadFile } = await import('./secure-io.js');
    const dir = pathResolver.rootResolve(process.env.KYBERION_MISSION_TASK_TRACE_DIR!);
    if (!safeExistsSync(dir)) return [];
    const traces: Array<{ rootSpan: any }> = [];
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

  it('acceptance (a): dispatch with delivered hints persists a trace whose span has non-empty knowledgeRefs', async () => {
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

    const dispatched = await dispatchMissionNextTasks(MISSION_ID);
    expect(dispatched).toEqual([
      { task_id: 'task-1', team_role: 'implementer', agent_id: 'implementation-architect' },
    ]);

    const traces = await readMissionTaskDispatchTraces();
    expect(traces.length).toBeGreaterThan(0);
    const span = traces[0].rootSpan;
    expect(span.knowledgeRefs).toContain(KNOWLEDGE_HINT_PATH);
    expect(span.attributes).toMatchObject({
      task_id: 'task-1',
      team_role: 'implementer',
      dispatched: true,
      result_schema_ok: true,
    });
    const knowledgeEvent = span.events.find((e: any) => e.name === 'knowledge_delivered');
    expect(knowledgeEvent).toBeTruthy();
    expect(knowledgeEvent?.attributes?.knowledge_ref_count).toBe(1);
    expect(String(knowledgeEvent?.attributes?.knowledge_refs_scored)).toContain(
      KNOWLEDGE_HINT_PATH
    );
  });

  it('acceptance (b): a tracing-store failure never affects dispatch', async () => {
    mocks.persistTraceShouldThrow.value = true;
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');
    const { safeReadFile } = await import('./secure-io.js');
    const { missionDir } = await import('./path-resolver.js');

    const dispatched = await dispatchMissionNextTasks(MISSION_ID);
    expect(dispatched).toEqual([
      { task_id: 'task-1', team_role: 'implementer', agent_id: 'implementation-architect' },
    ]);

    const stored = JSON.parse(
      safeReadFile(`${missionDir(MISSION_ID, 'public')}/NEXT_TASKS.json`, {
        encoding: 'utf8',
      }) as string
    );
    expect(stored.map((task: any) => task.status)).toEqual(['completed']);

    // No trace was persisted (the mocked seam threw before writing), but
    // dispatch itself completed exactly as in the success case above.
    const traces = await readMissionTaskDispatchTraces();
    expect(traces).toHaveLength(0);
  });
});
