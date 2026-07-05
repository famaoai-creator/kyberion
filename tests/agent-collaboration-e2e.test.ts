import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const route = vi.fn();
  const ensureMissionTeamRuntimeViaSupervisor = vi.fn();
  const resolveMissionTeamPlan = vi.fn();
  const resolveMissionTeamReceiver = vi.fn();
  const record = vi.fn();
  const emitMissionTaskEvent = vi.fn();

  return {
    route,
    ensureMissionTeamRuntimeViaSupervisor,
    resolveMissionTeamPlan,
    resolveMissionTeamReceiver,
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
  ].join('\n');
}

vi.mock('../libs/core/a2a-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../libs/core/a2a-bridge.js')>();
  return {
    ...actual,
    a2aBridge: {
      ...actual.a2aBridge,
      route: mocks.route,
    },
  };
});

vi.mock('../libs/core/agent-runtime-supervisor.js', () => ({
  ensureMissionTeamRuntimeViaSupervisor: mocks.ensureMissionTeamRuntimeViaSupervisor,
}));

vi.mock('../libs/core/mission-team-plan-composer.js', () => ({
  resolveMissionTeamPlan: mocks.resolveMissionTeamPlan,
  resolveMissionTeamReceiver: mocks.resolveMissionTeamReceiver,
}));

vi.mock('../libs/core/ledger.js', () => ({
  ledger: {
    record: mocks.record,
  },
}));

vi.mock('../libs/core/mission-task-events.js', () => ({
  emitMissionTaskEvent: mocks.emitMissionTaskEvent,
}));

describe.sequential('agent collaboration e2e', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    process.env.MISSION_ROLE = 'mission_controller';
    const { missionDir } = await import('../libs/core/path-resolver.js');
    const { clearWorkCoordinationStore, setWorkCoordinationNamespace } =
      await import('../libs/core/work-coordination.js');
    const { safeMkdir, safeWriteFile } = await import('../libs/core/secure-io.js');
    setWorkCoordinationNamespace('agent-collaboration-e2e');
    clearWorkCoordinationStore();
    const missionPath = missionDir('MSN-E2E-03', 'public');
    safeMkdir(missionPath, { recursive: true });
    safeMkdir(`${missionPath}/deliverables`, { recursive: true });
    safeWriteFile(`${missionPath}/deliverables/task-a.md`, '# task a');
    safeWriteFile(`${missionPath}/deliverables/REVIEW-task-1.md`, '# review');
    safeWriteFile(
      `${missionPath}/TASK_BOARD.md`,
      [
        '# TASK_BOARD: MSN-E2E-03',
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
  });

  afterEach(async () => {
    const { missionDir } = await import('../libs/core/path-resolver.js');
    const { clearWorkCoordinationStore, clearWorkCoordinationNamespace } =
      await import('../libs/core/work-coordination.js');
    const { safeExistsSync, safeRmSync } = await import('../libs/core/secure-io.js');
    const missionPath = missionDir('MSN-E2E-03', 'public');
    if (safeExistsSync(missionPath)) safeRmSync(missionPath);
    clearWorkCoordinationStore();
    clearWorkCoordinationNamespace();
  });

  it('injects upstream results, team snapshot, and review findings into the collaboration loop', async () => {
    const { dispatchMissionNextTasks } =
      await import('../libs/core/mission-orchestration-worker.js');
    const { missionDir } = await import('../libs/core/path-resolver.js');
    const { safeWriteFile, safeReadFile } = await import('../libs/core/secure-io.js');

    const missionPath = missionDir('MSN-E2E-03', 'public');

    mocks.ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue({
      runtime_plan: { mission_id: 'MSN-E2E-03', assignments: [] },
    });
    mocks.resolveMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-E2E-03',
      mission_type: 'product_development',
      assignments: [],
    });
    mocks.resolveMissionTeamReceiver.mockReturnValue({
      agent_id: 'implementation-architect',
      model_hint: {
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
      },
    });
    mocks.route.mockImplementation(async (envelope: any) => {
      const taskId = String(envelope?.payload?.context?.task_id || '');
      const prompt = String(envelope?.payload?.text || '');
      if (taskId === 'task-1' && prompt.includes('Review findings to address')) {
        return {
          payload: {
            text: makeTaskResultText({
              summary: 'Reworked the implementation.',
              artifacts: [{ path: 'deliverables/task-a.md', kind: 'markdown' }],
              verification_done: ['Addressed the reviewer feedback.'],
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

    const dispatched = await dispatchMissionNextTasks('MSN-E2E-03');
    const prompts = mocks.route.mock.calls.map((call) =>
      String((call[0] as any)?.payload?.text || '')
    );

    expect(prompts[1]).toContain('## Upstream results (inputs you MUST build on)');
    expect(prompts[1]).toContain('Completed the base implementation.');
    expect(prompts[1]).toContain(
      '## Team snapshot (do not duplicate; stay consistent with completed work)'
    );
    expect(prompts[2]).toContain('## Review findings to address');
    expect(prompts[2]).toContain('must_fix @ deliverables/task-a.md');

    expect(dispatched).toHaveLength(4);
    expect(dispatched.map((entry) => entry.task_id)).toEqual([
      'task-1',
      'task-2',
      'task-1',
      'task-2',
    ]);

    const stored = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(stored.map((task: any) => task.status)).toEqual(['completed', 'completed']);
    expect(stored[0].rework_count).toBe(1);
    expect(stored[0].last_result.summary).toContain('Reworked the implementation.');
  });
});
