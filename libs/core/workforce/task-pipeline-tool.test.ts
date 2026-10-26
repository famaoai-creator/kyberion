import { describe, expect, it, vi } from 'vitest';
import {
  createTaskPipelineTool,
  validateTaskPipelineRefs,
  type TaskPipelineCheckpoint,
  type TaskPipelineExecutor,
  type TaskPipelineToolOptions,
} from './task-pipeline-tool.js';
import type { TaskToolBinding } from './task-tool-runtime.js';

const binding: TaskToolBinding = {
  scope: {
    scope_kind: 'task',
    tier: 'public',
    mission_id: 'MSN-PIPELINE-TOOL',
    task_id: 'pipeline-task',
  },
  actorId: 'pipeline-worker',
  workItemId: 'pipeline-work',
  taskId: 'pipeline-task',
  missionId: 'MSN-PIPELINE-TOOL',
  leaseId: 'lease-first',
  capabilityProfile: 'implementer',
  readRoots: [],
  writeRoots: [],
};
const pipelineRef = 'pipelines/baseline-check.json';
function harness(execute: TaskPipelineExecutor) {
  const states = new Map<string, TaskPipelineCheckpoint>();
  let source = '{"steps":[]}';
  let outputs: Record<string, string> = {};
  const options: TaskPipelineToolOptions = {
    execute,
    assertCurrent: vi.fn(),
    source: () => source,
    checkpointPath: (name) => name,
    read: (name) => states.get(name) ?? null,
    write: (name, state) => {
      states.set(name, structuredClone(state));
    },
    lock: async (_name, run) => run(),
    outputHashes: () => outputs,
  };
  return {
    options,
    states,
    setSource: (value: string) => {
      source = value;
    },
    setOutputs: (value: Record<string, string>) => {
      outputs = value;
    },
  };
}
describe('durable task pipeline tool', () => {
  it('resumes the original suspended run across claims and does not repeat completed effects', async () => {
    let effects = 0;
    const execute = vi.fn<TaskPipelineExecutor>(async (request) => {
      if (!request.resumeRunId) {
        effects += 1;
        return {
          status: 'suspended',
          results: [],
          runId: 'run-original',
          approvalRequestId: 'approval-pipeline',
          storageChannel: 'pipeline-test',
        };
      }
      expect(request.resumeRunId).toBe('run-original');
      return { status: 'succeeded', results: [{ status: 'success' }], runId: 'run-original' };
    });
    const h = harness(execute);
    const first = createTaskPipelineTool(binding, [pipelineRef], h.options);
    await expect(first.execute({ pipeline_ref: pipelineRef }, binding)).rejects.toMatchObject({
      code: 'AGENT_APPROVAL_PENDING',
      approvalRequestId: 'approval-pipeline',
      approvalStorageChannel: 'pipeline-test',
      approvalKind: 'pipeline',
    });
    expect([...h.states.values()][0]).toMatchObject({
      status: 'suspended',
      run_id: 'run-original',
    });
    const nextBinding = { ...binding, leaseId: 'lease-second' };
    const next = createTaskPipelineTool(nextBinding, [pipelineRef], h.options);
    expect(await next.execute({ pipeline_ref: pipelineRef }, nextBinding)).toMatchObject({
      status: 'succeeded',
      runId: 'run-original',
    });
    expect(await next.execute({ pipeline_ref: pipelineRef }, nextBinding)).toMatchObject({
      status: 'succeeded',
      recovered: true,
    });
    expect(effects).toBe(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('does not replay an uncertain start after interruption', async () => {
    const execute = vi.fn<TaskPipelineExecutor>(async () => {
      throw new Error('interrupted after effect');
    });
    const h = harness(execute);
    const first = createTaskPipelineTool(binding, [pipelineRef], h.options);
    await expect(first.execute({ pipeline_ref: pipelineRef }, binding)).rejects.toThrow(
      'interrupted'
    );
    const restarted = createTaskPipelineTool(binding, [pipelineRef], h.options);
    await expect(restarted.execute({ pipeline_ref: pipelineRef }, binding)).rejects.toThrow(
      'TASK_PIPELINE_EFFECT_UNCERTAIN'
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rejects scope, output, or source changes before resuming or trusting a cached receipt', async () => {
    const execute = vi.fn<TaskPipelineExecutor>(async () => ({
      status: 'succeeded',
      results: [{ status: 'success' }],
      runId: 'run-verified',
    }));
    const h = harness(execute);
    h.setOutputs({ 'evidence/report.md': 'hash-original' });
    const tool = createTaskPipelineTool(binding, [pipelineRef], h.options);
    await tool.execute({ pipeline_ref: pipelineRef }, binding);
    h.setOutputs({ 'evidence/report.md': 'hash-tampered' });
    await expect(tool.execute({ pipeline_ref: pipelineRef }, binding)).rejects.toThrow(
      'TASK_PIPELINE_OUTPUT_CHANGED'
    );
    h.setOutputs({ 'evidence/report.md': 'hash-original' });
    const other = {
      ...binding,
      scope: { ...binding.scope, tier: 'confidential' as const, tenant_slug: 'other-tenant' },
    };
    await expect(
      createTaskPipelineTool(other, [pipelineRef], h.options).execute(
        { pipeline_ref: pipelineRef },
        other
      )
    ).rejects.toThrow('TASK_PIPELINE_CHECKPOINT_INVALID');
    h.setSource('{"steps":["changed"]}');
    await expect(tool.execute({ pipeline_ref: pipelineRef }, binding)).rejects.toThrow(
      'TASK_PIPELINE_SOURCE_CHANGED'
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rejects an ungranted pipeline and malformed success receipt', async () => {
    const execute = vi.fn<TaskPipelineExecutor>(async () => ({
      status: 'succeeded',
      results: [{ status: 'failed' }],
    }));
    const h = harness(execute);
    const tool = createTaskPipelineTool(binding, [pipelineRef], h.options);
    await expect(tool.execute({ pipeline_ref: 'pipelines/other.json' }, binding)).rejects.toThrow(
      'TASK_PIPELINE_DENIED'
    );
    expect(execute).not.toHaveBeenCalled();
    await expect(tool.execute({ pipeline_ref: pipelineRef }, binding)).rejects.toThrow(
      'TASK_PIPELINE_FAILED'
    );
  });
  it.each(['../private.json', 'knowledge/personal/private.json', 'pipelines/../private.json'])(
    'rejects invalid declaration %s',
    (ref) => {
      expect(() => validateTaskPipelineRefs([ref])).toThrow('TASK_PIPELINE_GRANT_INVALID');
    }
  );
});
