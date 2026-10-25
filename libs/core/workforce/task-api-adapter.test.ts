import { describe, expect, it, vi } from 'vitest';
import './worker-goal-driver.js';
import { TaskApiAdapter } from './task-api-adapter.js';
import type { TaskToolRuntime } from './task-tool-runtime.js';
import type {
  GenerateWithToolsResult,
  ToolDefinition,
  ReasoningCallOptions,
} from '../reasoning/reasoning-backend.js';
import { WorkerEventStream } from './worker-event-stream.js';
import { DynamicInjectionRegistry } from '../dynamic-injection.js';

function runtime(): TaskToolRuntime {
  return {
    binding: {
      scope: { scope_kind: 'task', tier: 'public', mission_id: 'MSN-API-TASK', task_id: 'report' },
      actorId: 'api-worker',
      workItemId: 'api-work',
      taskId: 'report',
      missionId: 'MSN-API-TASK',
      leaseId: 'api-lease',
      capabilityProfile: 'implementer',
      readRoots: [],
      writeRoots: [],
    },
    definitions: [
      {
        name: 'make_report',
        description: 'Produce report',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    execute: vi.fn(async () => ({ path: 'evidence/report.md' })),
    assertCurrent: vi.fn(),
  };
}
const loopOptions = () => ({
  stream: new WorkerEventStream(),
  injectionRegistry: new DynamicInjectionRegistry(),
  auditToolCall: vi.fn(),
});
describe('provider-neutral task API adapter', () => {
  it.each([false, true])(
    'uses function tools and model routing with isolated CLI=%s',
    async (isolated) => {
      const bound = runtime();
      const outputs: GenerateWithToolsResult[] = [
        { toolCalls: [{ name: 'make_report', input: {} }] },
        {
          text: 'TASK_RESULT: report verified',
          toolCalls: [
            { name: 'goal_update', input: { status: 'complete', reason: 'report verified' } },
          ],
        },
      ];
      const generateWithTools = vi.fn(
        async (_prompt: string, _tools: ToolDefinition[], _options?: ReasoningCallOptions) =>
          outputs.shift()!
      );
      const adapter = new TaskApiAdapter({
        mode: isolated ? 'claude-cli' : 'fake-api',
        modelId: 'provider-model',
        runtime: bound,
        backend: { generateWithTools },
        isolateNativeTools: isolated,
        loopOptions: loopOptions(),
      });
      const response = await adapter.ask('Create report');
      expect(response).toMatchObject({
        stopReason: 'end_turn',
        text: 'TASK_RESULT: report verified',
      });
      expect(bound.execute).toHaveBeenCalledWith({ name: 'make_report', arguments: {} });
      expect(generateWithTools).toHaveBeenCalledWith(
        expect.stringContaining('Create report'),
        expect.arrayContaining([expect.objectContaining({ name: 'make_report' })]),
        expect.objectContaining({
          model: 'provider-model',
          capability_profile: isolated ? 'planner' : 'implementer',
          signal: expect.any(AbortSignal),
        })
      );
      expect(generateWithTools.mock.calls[1]?.[0]).toContain('evidence/report.md');
    }
  );
  it('refuses a backend without tool support instead of returning text-only success', async () => {
    const adapter = new TaskApiAdapter({ mode: 'text-only', runtime: runtime(), backend: {} });
    await expect(adapter.boot()).rejects.toThrow('TASK_TOOL_CAPABILITY_UNAVAILABLE');
  });
  it('discards late provider tool calls after cancellation even when backend ignores its signal', async () => {
    const bound = runtime();
    const controller = new AbortController();
    const adapter = new TaskApiAdapter({
      mode: 'fake-api',
      runtime: bound,
      loopOptions: loopOptions(),
      backend: {
        generateWithTools: async () => {
          controller.abort();
          return { toolCalls: [{ name: 'make_report', input: {} }] };
        },
      },
    });
    await expect(adapter.ask('Create report', { signal: controller.signal })).rejects.toThrow(
      'TASK_TOOL_CANCELLED'
    );
    expect(bound.execute).not.toHaveBeenCalled();
  });
});
