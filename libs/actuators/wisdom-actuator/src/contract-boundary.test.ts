import { describe, expect, it, vi } from 'vitest';
import {
  pathResolver,
  safeReadFile,
  registerActuatorForwardingPort,
  resetActuatorForwardingPort,
} from '@agent/core';
import { describeOps } from './op-catalog.js';
import { handleAction, runWithOperationRetry } from './wisdom-pipeline-helpers.js';
import { createWisdomDispatcher } from './wisdom-dispatcher.js';

function readJson<T>(relativePath: string): T {
  return JSON.parse(
    safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) as string
  ) as T;
}

describe('wisdom public contract boundaries', () => {
  it('dispatches a direct knowledge_search action instead of succeeding as an empty pipeline', async () => {
    const result = await handleAction({
      action: 'knowledge_search',
      params: { query: 'architecture' },
    });

    expect(result.status).toBe('succeeded');
    expect(result.context.found_knowledge).toBeDefined();
    expect(result.context.found_knowledge).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_ref: expect.any(String),
          tier: expect.any(String),
          title: expect.any(String),
          tags: expect.any(Array),
          score: expect.any(Number),
          retrieval_reason: expect.any(String),
          provenance: expect.any(Object),
        }),
      ])
    );
  });

  it('fails closed when non-public knowledge is requested without a tenant scope', async () => {
    const result = await handleAction({
      action: 'knowledge_search',
      params: { query: 'architecture', tier: 'confidential' },
    });

    expect(result.status).toBe('failed');
    expect(JSON.stringify(result.results)).toContain('KNOWLEDGE_SCOPE_REQUIRED');
  });

  it('publishes pipeline and reconcile in the schema contract', () => {
    const schema = readJson<{ properties: { action: { enum?: string[] } } }>(
      'schemas/wisdom-action.schema.json'
    );

    expect(schema.properties.action.enum).toEqual(
      expect.arrayContaining(['pipeline', 'reconcile'])
    );
  });

  it('keeps manifest and describeOps operation sets aligned', () => {
    const manifest = readJson<{ capabilities: Array<{ op: string }> }>(
      'libs/actuators/wisdom-actuator/manifest.json'
    );
    const manifestOps = manifest.capabilities.map(({ op }) => op).sort();
    const catalogOps = describeOps()
      .map(({ op }) => op)
      .sort();

    expect(manifestOps).toEqual(catalogOps);
  });

  it('retains an apply decision result in pipeline context under export_as', async () => {
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'apply',
          op: 'stakeholder_grid_sort',
          params: {
            nodes: [
              { name: 'low', influence_level: 'low', interest_level: 'low' },
              { name: 'high', influence_level: 'high', interest_level: 'high' },
            ],
            export_as: 'sorted_stakeholders',
          },
        },
      ],
      context: {},
    });

    expect(result.status).toBe('succeeded');
    expect(result.context.sorted_stakeholders).toEqual([
      { name: 'high', influence_level: 'high', interest_level: 'high' },
      { name: 'low', influence_level: 'low', interest_level: 'low' },
    ]);
  });

  it('does not produce different result semantics when a canonical capture op is direct or pipelined', async () => {
    const direct = await handleAction({
      action: 'knowledge_search',
      params: { query: 'architecture' },
    });
    const pipelined = await handleAction({
      action: 'pipeline',
      steps: [{ type: 'capture', op: 'knowledge_search', params: { query: 'architecture' } }],
      context: {},
    });

    expect(pipelined.context.found_knowledge).toEqual(direct.context.found_knowledge);
  });

  it('fails when a canonical op is invoked with the wrong pipeline step type', async () => {
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'transform',
          op: 'knowledge_search',
          params: { query: 'architecture' },
        },
      ],
      context: {},
    });

    expect(result.status).toBe('failed');
    expect(result.results[0].error).toContain('OP_KIND_MISMATCH');
  });

  it('fails unknown transform and apply operations instead of warning-success', async () => {
    for (const type of ['transform', 'apply'] as const) {
      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type, op: 'does_not_exist', params: {} }],
        context: {},
      });

      expect(result.status).toBe('failed');
      expect(result.results[0].error).toContain('UNKNOWN_OP');
    }
  });

  it('does not retry a non-idempotent side-effect operation', async () => {
    let attempts = 0;
    await expect(
      runWithOperationRetry('shell', async () => {
        attempts += 1;
        throw new Error('side effect failed');
      })
    ).rejects.toThrow('side effect failed');
    expect(attempts).toBe(1);
  });

  it('propagates nested pipeline failures to the parent pipeline', async () => {
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'control',
          op: 'if',
          params: {
            condition: { from: 'nested_flag', operator: 'eq', value: true },
            then: [{ type: 'transform', op: 'missing_nested_op', params: {} }],
          },
        },
      ],
      context: { nested_flag: true },
    });

    expect(result.status).toBe('failed');
    expect(JSON.stringify(result.results)).toContain('UNKNOWN_OP');
  });

  it('marks a2a_fanout as a deprecated reasoning ensemble alias', () => {
    const alias = describeOps().find(({ op }) => op === 'a2a_fanout');

    expect(alias).toMatchObject({
      deprecated: true,
      canonical_op: 'perspective_fanout',
      execution_kind: 'reasoning_ensemble',
    });
  });

  it('records deprecated alias use in a reasoning ensemble receipt', async () => {
    const dispatcher = createWisdomDispatcher({
      capture: async (_op, _params, context) => context,
      transform: async (_op, _params, context) => context,
      apply: async (_op, _params, context) => context,
    });
    const result = await dispatcher.dispatch('apply', 'a2a_fanout', {}, {});

    expect(result.receipt).toMatchObject({
      requested_op: 'a2a_fanout',
      canonical_op: 'perspective_fanout',
      execution_kind: 'reasoning_ensemble',
      compatibility: { deprecated_alias: 'a2a_fanout' },
    });
  });

  it('publishes canonical names for perspective, counterparty, tool proposal, and reasoning loop ops', () => {
    const catalog = describeOps();
    expect(catalog.map(({ op }) => op)).toEqual(
      expect.arrayContaining([
        'perspective_fanout',
        'counterparty_roleplay',
        'typed_cross_critique',
        'propose_tool_calls',
        'reasoning_loop',
      ])
    );
    expect(catalog.find(({ op }) => op === 'a2a_roleplay')).toMatchObject({
      deprecated: true,
      canonical_op: 'counterparty_roleplay',
    });
    expect(catalog.find(({ op }) => op === 'tool_use')).toMatchObject({
      deprecated: true,
      canonical_op: 'propose_tool_calls',
    });
    expect(catalog.find(({ op }) => op === 'react_loop')).toMatchObject({
      deprecated: true,
      canonical_op: 'reasoning_loop',
    });
  });

  it('keeps Agent runtime SDK ownership outside Wisdom and task-executor', () => {
    const wisdomSource = safeReadFile(
      pathResolver.rootResolve('libs/actuators/wisdom-actuator/src/decision-ops.ts'),
      { encoding: 'utf8' }
    ) as string;
    const executorSource = safeReadFile(pathResolver.rootResolve('libs/core/task-executor.ts'), {
      encoding: 'utf8',
    }) as string;

    expect(wisdomSource).not.toContain('@anthropic-ai/claude-agent-sdk');
    expect(wisdomSource).not.toContain('executeTaskPlan');
    expect(executorSource).not.toContain('@anthropic-ai/claude-agent-sdk');
  });

  it('exposes moved boundary operations as compatibility forwarders', () => {
    for (const op of [
      'shell',
      'read_file',
      'write_file',
      'pptx_diff',
      'transcribe_audio',
      'execute_task_plan',
    ]) {
      expect(describeOps().find((entry) => entry.op === op)).toMatchObject({
        forward_to: expect.any(Object),
      });
    }
  });

  it('forwards a boundary operation through the typed port in canonical mode', async () => {
    const forward = vi.fn().mockResolvedValue({
      forwarded_to: 'terminal:shell_command',
      status: 'succeeded',
      result: { stdout: 'forwarded' },
    });
    registerActuatorForwardingPort({ forward });
    try {
      const result = await handleAction({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'shell', params: { cmd: 'printf forwarded' } }],
        context: {},
      });

      expect(result.status).toBe('succeeded');
      expect(result.context.last_capture).toEqual({ stdout: 'forwarded' });
      expect(forward).toHaveBeenCalledWith(
        expect.objectContaining({
          source_actuator: 'wisdom-actuator',
          target_actuator: 'terminal',
          target_op: 'shell_command',
        })
      );
    } finally {
      resetActuatorForwardingPort();
    }
  });

  it('keeps perspective fanout on reasoning backends and outside Agent runtime lifecycle', async () => {
    const source = safeReadFile(
      pathResolver.rootResolve('libs/actuators/wisdom-actuator/src/decision-ops.ts'),
      { encoding: 'utf8' }
    ) as string;
    expect(source).toContain("case 'perspective_fanout'");
    expect(source).not.toContain('ensureAgentRuntime');
    expect(source).not.toContain('getAgentExecutionPort');
  });

  it('keeps decision fallback inside the typed dispatcher and removes Wisdom shell/file handlers', () => {
    const pipelineSource = safeReadFile(
      pathResolver.rootResolve('libs/actuators/wisdom-actuator/src/wisdom-pipeline-helpers.ts'),
      { encoding: 'utf8' }
    ) as string;

    expect(pipelineSource).toContain('fallback: async (_kind, op, params, currentCtx)');
    expect(pipelineSource).not.toContain('safeExec(');
    expect(pipelineSource).not.toContain(
      'const decision = await dispatchDecisionOp(op, params, ctx'
    );
  });

  it('keeps task-plan DAG coordination in Orchestrator and core as a port facade', () => {
    const coreExecutor = safeReadFile(pathResolver.rootResolve('libs/core/task-executor.ts'), {
      encoding: 'utf8',
    }) as string;
    const orchestratorSource = safeReadFile(
      pathResolver.rootResolve('libs/actuators/orchestrator-actuator/src/orchestrator-helpers.ts'),
      { encoding: 'utf8' }
    ) as string;

    expect(coreExecutor).toContain('getTaskPlanCoordinator');
    expect(coreExecutor).not.toContain('topologicalOrder');
    expect(orchestratorSource).toContain('executeTaskPlanFromOrchestrator');
    expect(orchestratorSource).not.toContain("import('@agent/core')");
  });
});
