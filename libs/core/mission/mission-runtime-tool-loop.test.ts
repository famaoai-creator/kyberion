import { afterEach, describe, expect, it, vi } from 'vitest';
import '../workforce/worker-goal-driver.js';
import '../../../scripts/task_pipeline_executor.js';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import * as secureIo from '../secure-io.js';
import { withExecutionContext } from '../authority.js';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { withTaskRuntimeExecution } from '../agent/agent-lifecycle.js';
import { createRuntimeForTask, runTaskToolLoop } from '../workforce/task-tool-runtime.js';
import {
  createWorkItem,
  claimWorkItem,
  getWorkItem,
  listActiveWorkLeases,
  clearWorkCoordinationStore,
  setWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import { WorkerEventStream } from '../workforce/worker-event-stream.js';
import { DynamicInjectionRegistry } from '../dynamic-injection.js';
import { writeMissionStateAtPath } from './mission-state-reader.js';
import { loadMissionNextTaskObjectsAtPath } from './mission-next-task-reader.js';
import type { MissionState } from './mission-types.js';
import type { GenerateWithToolsResult } from '../reasoning/reasoning-backend.js';

const missionId = `MSN-VITEST-RUNTIME-TOOLS-${process.pid}`;
const taskId = 'produce-report';
const missionPath = pathResolver.missionDir(missionId, 'public');
const sourceTarget = `libs/core/testing/runtime-source-fixture-${process.pid}.txt`;
const pipelineRef = `pipelines/runtime-task-fixture-${process.pid}.json`;
afterEach(() => {
  withExecutionContext('mission_controller', () => {
    clearWorkCoordinationStore();
    safeRmSync(missionPath, { recursive: true, force: true });
  });
  withExecutionContext(
    'ecosystem_architect',
    () => {
      safeRmSync(pathResolver.rootResolve(sourceTarget), { force: true });
      safeRmSync(pathResolver.rootResolve(pipelineRef), { force: true });
    },
    'ecosystem_architect'
  );
  setWorkCoordinationNamespace(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('runtime task tool loop with native mission contracts', () => {
  for (const mode of ['deliverable', 'source', 'pipeline'] as const)
    it(`writes ${mode} and records real controller evidence before completion`, async () => {
      const sourceOnly = mode === 'source';
      const pipeline = mode === 'pipeline';
      vi.stubEnv('MISSION_ID', missionId);
      vi.stubEnv('KYBERION_TENANT', '');
      vi.stubEnv('KYBERION_CUSTOMER', '');
      vi.stubEnv('KYBERION_PROJECT_ID', '');
      vi.stubEnv('KYBERION_REASONING_BACKEND', 'stub');
      vi.stubEnv('MISSION_ROLE', 'mission_controller');
      vi.stubEnv('KYBERION_PERSONA', 'worker');
      setWorkCoordinationNamespace(`runtime-tool-loop-${process.pid}`);
      const state = {
        mission_id: missionId,
        mission_type: 'development',
        tier: 'public',
        status: 'active',
        execution_mode: 'local',
        priority: 3,
        assigned_persona: 'worker',
        confidence_score: 1,
        git: { branch: 'test', start_commit: 'test', latest_commit: 'test', checkpoints: [] },
        history: [],
      } as MissionState;
      writeMissionStateAtPath(path.join(missionPath, 'mission-state.json'), state);
      const tasksPath = path.join(missionPath, 'NEXT_TASKS.json');
      safeWriteFile(
        tasksPath,
        JSON.stringify([
          {
            task_id: taskId,
            status: 'planned',
            assigned_to: { role: 'implementer' },
            description: 'Produce a verified runtime report using granted tools',
            ...(sourceOnly
              ? { target_path: sourceTarget, source_edit_requires_approval: false }
              : { deliverable: 'evidence/runtime-report.md' }),
            dependencies: [],
            acceptance_criteria: ['Report exists with verified content'],
            phase: 'execution',
            phase_kind: 'implement',
            ...(pipeline ? { allowed_pipelines: [pipelineRef] } : {}),
          },
        ]),
        { mkdir: true }
      );
      if (pipeline)
        withExecutionContext(
          'ecosystem_architect',
          () =>
            safeWriteFile(
              pathResolver.rootResolve(pipelineRef),
              JSON.stringify({
                action: 'pipeline',
                name: 'Task runtime output fixture',
                version: '1.0.0',
                steps: [
                  {
                    id: 'observe',
                    role: 'sink',
                    op: 'system:log',
                    params: {
                      message: 'Deterministic declared task pipeline completed',
                    },
                  },
                ],
              })
            ),
          'ecosystem_architect'
        );
      // Native missions have independent Git repositories; otherwise the real
      // controller would incorrectly discover this checkout's parent Git root.
      secureIo.safeExec('git', ['init', '--quiet'], { cwd: missionPath });
      secureIo.safeExec('git', ['config', 'user.name', 'Runtime Integration'], {
        cwd: missionPath,
      });
      secureIo.safeExec('git', ['config', 'user.email', 'runtime-test@invalid'], {
        cwd: missionPath,
      });
      secureIo.safeExec('git', ['add', '.'], { cwd: missionPath });
      secureIo.safeExec('git', ['commit', '--quiet', '-m', 'Initialize mission fixture'], {
        cwd: missionPath,
      });
      const scope = { tier: 'public' as const, mission_id: missionId, task_id: taskId };
      const item = createWorkItem({
        title: 'Produce runtime report',
        description: 'Write the declared report and record verified task evidence',
        status: 'ready',
        projectId: missionId,
        context: { mission_id: missionId, task_id: taskId },
        metadata: { team_role: 'implementer' },
      });
      const claimed = claimWorkItem({
        itemId: item.item_id,
        actorPeerId: 'runtime-loop-worker',
        purpose: 'integration proof',
      });
      const runtime = createRuntimeForTask(
        {
          work_item_id: item.item_id,
          capability_profile: 'implementer',
          lease_id: claimed.lease.lease_id,
        },
        scope
      )!;
      const replies: GenerateWithToolsResult[] = [
        {
          toolCalls: [
            {
              name: 'kyberion_task_read_file',
              input: { path: 'libs/core/workforce/task-execution-port.ts' },
            },
            {
              name: pipeline
                ? 'kyberion_task_run_pipeline'
                : sourceOnly
                  ? 'kyberion_task_write_source'
                  : 'kyberion_task_write_deliverable',
              input: pipeline
                ? { pipeline_ref: pipelineRef }
                : {
                    ...(sourceOnly ? { path: sourceTarget } : {}),
                    content: '# Verified runtime report\n',
                  },
            },
            ...(pipeline
              ? [
                  {
                    name: 'kyberion_task_write_deliverable',
                    input: { content: '# Verified runtime report\n' },
                  },
                ]
              : []),
          ],
        },
        {
          toolCalls: [
            {
              name: 'kyberion_task_record_evidence',
              input: { note: 'Declared artifact written and read back during runtime integration' },
            },
          ],
        },
        {
          text: 'TASK_RESULT: runtime report produced and verified',
          toolCalls: [
            {
              name: 'goal_update',
              input: { status: 'complete', reason: 'Artifact and controller evidence verified' },
            },
          ],
        },
      ];
      const prompts: string[] = [];
      const executions: unknown[] = [];
      const realExec = secureIo.safeExecResultAsync;
      vi.spyOn(secureIo, 'safeExecResultAsync').mockImplementation(async (...args) => {
        const result = await realExec(...args);
        executions.push(result);
        return result;
      });
      const result = await withTaskRuntimeExecution(runtime, 'stub', () =>
        runTaskToolLoop(
          runtime,
          {
            generateWithTools: async (prompt) => {
              expect(currentExecutionScope()?.assumedRole).toBe('task_runtime_worker');
              expect(getWorkItem(item.item_id)?.claimed_by_peer_id).toBe('runtime-loop-worker');
              expect(
                listActiveWorkLeases().some(
                  (lease) =>
                    lease.lease_id === claimed.lease.lease_id &&
                    lease.holder_peer_id === 'runtime-loop-worker'
                )
              ).toBe(true);
              prompts.push(prompt);
              return replies.shift()!;
            },
          },
          'Produce the report through the declared task tools',
          {
            stream: new WorkerEventStream(),
            injectionRegistry: new DynamicInjectionRegistry(),
            auditToolCall: vi.fn(),
            maxTurns: 4,
          }
        )
      ).catch((error) => {
        throw new Error(`${String(error)}; controller=${JSON.stringify(executions)}`);
      });
      const outputPath = sourceOnly
        ? pathResolver.rootResolve(sourceTarget)
        : path.join(missionPath, 'evidence/runtime-report.md');
      expect(result.stopReason).toBe('end_turn');
      expect(safeExistsSync(outputPath)).toBe(true);
      expect(safeReadFile(outputPath, { encoding: 'utf8' })).toBe('# Verified runtime report\n');
      expect(prompts[1]).toContain(
        pipeline ? 'succeeded' : sourceOnly ? sourceTarget : 'runtime-report.md'
      );
      expect(loadMissionNextTaskObjectsAtPath(tasksPath, missionId)?.[0]?.status).toBe('completed');
    }, 30_000);
});
