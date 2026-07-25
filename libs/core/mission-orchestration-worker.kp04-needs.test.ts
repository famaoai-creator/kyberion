import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// KP-04: when a task_result reports unresolved `needs`, the retry prompt
// gets a targeted second-round retrieval (the needs strings as query via
// findRelevantDistilledKnowledge) instead of just re-sending the same
// context. This mocks findRelevantDistilledKnowledge (the same seam
// mission-context-pack.test.ts mocks) so both the first-round context pack
// search and the second-round needs-driven search are deterministic and
// hermetic — no real corpus lookups.
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
  ledger: { record: mocks.record },
}));

vi.mock('./mission-task-events.js', () => ({
  emitMissionTaskEvent: mocks.emitMissionTaskEvent,
}));

vi.mock('./distill-knowledge-injector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./distill-knowledge-injector.js')>();
  return {
    ...actual,
    findRelevantDistilledKnowledge: mocks.findRelevantDistilledKnowledge,
  };
});

const MISSION_ID = 'MSN-KP04-NEEDS';

// Full dispatch flow through real module wiring, same style as
// mission-orchestration-worker.test.ts — comfortably fast locally.
describe(
  'mission-orchestration-worker KP-04 needs-driven second-round retrieval',
  { timeout: 60_000 },
  () => {
    beforeEach(async () => {
      vi.resetModules();
      vi.resetAllMocks();
      process.env.MISSION_ROLE = 'mission_controller';
      const { missionDir, pathResolver } = await import('./path-resolver.js');
      process.env.KYBERION_TEST_OBSERVABILITY_DIR = pathResolver.shared(
        `tmp/vitest-observability/kp04-needs-${process.pid}`
      );
      process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR = pathResolver.shared(
        `tmp/vitest-knowledge-delivery/kp04-needs-${process.pid}`
      );
      process.env.KYBERION_KNOWLEDGE_USAGE_PATH = pathResolver.shared(
        `tmp/vitest-knowledge-usage/kp04-needs-${process.pid}/usage.json`
      );
      process.env.KYBERION_MEMORY_QUEUE_PATH = pathResolver.shared(
        `tmp/vitest-memory-queue/kp04-needs-${process.pid}/promotion-queue.jsonl`
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
      setWorkCoordinationNamespace('mission-orchestration-worker-kp04-needs-test');
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
              branch: 'mission/kp04-needs',
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
      const { missionDir } = await import('./path-resolver.js');
      const { clearWorkCoordinationStore, clearWorkCoordinationNamespace } =
        await import('./work-coordination.js');
      const { safeExistsSync, safeRmSync } = await import('./secure-io.js');
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

    it('appends a targeted knowledge delta for unresolved needs, excluding already-delivered paths', async () => {
      const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

      // Round 1 (the mission context pack's own search, driven by mission /
      // work item text) surfaces only the "already delivered" doc. Round 2
      // (queried with the needs text itself) surfaces that same doc again
      // plus a genuinely new one — the delta must keep only the new one.
      mocks.findRelevantDistilledKnowledge.mockImplementation(async (input: { topic: string }) => {
        if (input.topic.includes('widget procedure unknown')) {
          return [
            {
              path: 'knowledge/product/architecture/already-delivered.md',
              title: 'Already Delivered Doc',
              excerpt: 'This one was already delivered in the first-round context pack.',
              tags: [],
              score: 0.9,
            },
            {
              path: 'knowledge/product/architecture/new-procedure-doc.md',
              title: 'Widget Procedure Guide',
              excerpt: 'Step-by-step widget procedure the worker needed.',
              tags: [],
              score: 0.8,
            },
          ];
        }
        return [
          {
            path: 'knowledge/product/architecture/already-delivered.md',
            title: 'Already Delivered Doc',
            excerpt: 'This one was delivered up-front in the first-round context pack.',
            tags: [],
            score: 0.9,
          },
        ];
      });

      mocks.route
        .mockResolvedValueOnce({
          payload: {
            text: makeTaskResultText({
              summary: 'Blocked pending the widget procedure.',
              needs: ['widget procedure unknown'],
            }),
          },
        })
        .mockResolvedValueOnce({
          payload: {
            text: makeTaskResultText({
              summary: 'Completed the widget using the retrieved procedure.',
            }),
          },
        });

      await dispatchMissionNextTasks(MISSION_ID);

      expect(mocks.route).toHaveBeenCalledTimes(2);

      const firstPrompt = String((mocks.route.mock.calls[0]?.[0] as any)?.payload?.text || '');
      expect(firstPrompt).toContain('Already Delivered Doc');

      const retryPrompt = String((mocks.route.mock.calls[1]?.[0] as any)?.payload?.text || '');
      expect(retryPrompt).toContain('needs unresolved: widget procedure unknown');
      expect(retryPrompt).toContain('Widget Procedure Guide');
      expect(retryPrompt).toContain('knowledge/product/architecture/new-procedure-doc.md');
      // The already-delivered doc must not be re-listed in the delta.
      expect(retryPrompt).not.toContain('knowledge/product/architecture/already-delivered.md');
      expect(retryPrompt).not.toContain('Already Delivered Doc');
    });

    it('does not call the retrieval seam again when the retry is only for parse errors (no needs)', async () => {
      const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

      mocks.findRelevantDistilledKnowledge.mockResolvedValue([]);

      mocks.route
        .mockResolvedValueOnce({
          payload: { text: 'not a task_result block at all' },
        })
        .mockResolvedValueOnce({
          payload: {
            text: makeTaskResultText({ summary: 'Completed after the parse-error retry.' }),
          },
        });

      await dispatchMissionNextTasks(MISSION_ID);

      expect(mocks.route).toHaveBeenCalledTimes(2);
      const retryPrompt = String((mocks.route.mock.calls[1]?.[0] as any)?.payload?.text || '');
      expect(retryPrompt).not.toContain('Additional knowledge retrieved for the unresolved needs');
    });
  }
);
