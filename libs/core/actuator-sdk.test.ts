import { describe, expect, it, vi } from 'vitest';
import {
  defineActuator,
  defineCatalogBackedActuator,
  defineLegacyPipelineActuator,
  runAdfActuatorPipeline,
  runActuatorPipeline,
  runActuatorStepSequence,
  withCatalogInputContract,
} from './actuator-sdk.js';
import { registerOpPreflightListener } from './op-preflight.js';
import { resolveSandboxPolicy } from './sandbox-policy.js';
import { validateUrl } from './secure-io.js';

describe('actuator SDK', () => {
  it('derives operation descriptions and returns one result envelope', async () => {
    const actuator = defineActuator({
      id: 'demo-actuator',
      ops: {
        echo: {
          kind: 'transform',
          input_schema: { type: 'object' },
          validateInput: (value: unknown) => {
            if (!value || typeof value !== 'object' || !('text' in value)) {
              throw new Error('text is required');
            }
            return String((value as { text: unknown }).text);
          },
          handler: async (input: string) => input.toUpperCase(),
        },
      },
    });

    expect(actuator.describeOps()).toEqual([
      { op: 'echo', kind: 'transform', input_schema: { type: 'object' } },
    ]);
    await expect(actuator.dispatch('echo', { text: 'hello' })).resolves.toMatchObject({
      ok: true,
      status: 'succeeded',
      output: 'HELLO',
    });
    await expect(actuator.dispatch('missing', {})).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error: expect.stringContaining('[UNKNOWN_OP]'),
    });
  });

  it('converts input validation and handler errors into the same envelope', async () => {
    const actuator = defineActuator({
      id: 'demo-actuator',
      ops: {
        fail: {
          kind: 'apply',
          validateInput: () => {
            throw new Error('invalid input');
          },
          handler: () => 'unreachable',
        },
      },
    });
    await expect(actuator.dispatch('fail', {})).resolves.toEqual({
      ok: false,
      status: 'failed',
      actuator_id: 'demo-actuator',
      op: 'fail',
      error: 'invalid input',
    });
  });

  it('adapts a legacy pipeline handler behind the execute operation', async () => {
    const seen: unknown[] = [];
    const actuator = defineLegacyPipelineActuator({
      id: 'legacy-demo',
      handleAction: (input) => {
        seen.push(input);
        return { result: 'ok' };
      },
    });

    await expect(
      actuator.dispatch(
        'execute',
        { op: 'demo:run', type: 'transform', params: { value: 1 } },
        { request_id: 'r1' }
      )
    ).resolves.toMatchObject({ ok: true, output: { result: 'ok' } });
    expect(seen).toEqual([
      {
        action: 'pipeline',
        steps: [{ type: 'transform', op: 'demo:run', params: { value: 1 } }],
        context: { request_id: 'r1' },
      },
    ]);
  });

  it('enforces authored catalog schemas before dispatching the legacy handler', async () => {
    const seen: unknown[] = [];
    const actuator = defineCatalogBackedActuator({
      id: 'catalog-demo',
      describeOps: () => [
        {
          op: 'create',
          kind: 'apply',
          input_schema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
        },
      ],
      handleAction: (input) => {
        seen.push(input);
        return { status: 'ok' };
      },
    });

    await expect(actuator.dispatch('create', {})).resolves.toMatchObject({
      ok: false,
      error: "Invalid input for catalog-demo:create: / must have required property 'name'",
    });
    await expect(actuator.dispatch('create', { name: 'demo' })).resolves.toMatchObject({
      ok: true,
      output: { status: 'ok' },
    });
    await expect(
      actuator.dispatch('create', {
        name: 'demo',
        _facets: undefined,
        _reasoning_policy: undefined,
        _step_id: 'create',
      })
    ).resolves.toMatchObject({ ok: true });
    expect(seen).toHaveLength(2);
  });

  it('uses the catalog-provided legacy contract for runtime pipeline operations', async () => {
    const actuator = defineCatalogBackedActuator({
      id: 'browser-actuator',
      describeOps: () => [
        withCatalogInputContract('browser', 'click_ref', 'apply', {
          op: 'click_ref',
          kind: 'apply' as const,
          input_schema: {
            type: 'object',
            required: ['ref'],
            additionalProperties: false,
          },
        }),
      ],
      handleAction: (input) => ({ status: 'ok', input }),
    });

    await expect(actuator.dispatch('click_ref', { legacy_ref: '@e1' })).resolves.toMatchObject({
      ok: true,
      output: { status: 'ok' },
    });
  });

  it('resolves typed pipeline placeholders before runtime validation', async () => {
    const seen: unknown[] = [];
    const actuator = defineCatalogBackedActuator({
      id: 'placeholder-demo-actuator',
      describeOps: () => [
        {
          op: 'approve',
          kind: 'apply' as const,
          input_schema: {
            type: 'object',
            required: ['approved', 'occurred_at'],
            properties: {
              approved: { type: 'boolean' },
              occurred_at: { type: 'string', format: 'date-time' },
            },
            additionalProperties: false,
          },
        },
      ],
      handleAction: (input) => {
        seen.push(input);
        return { status: 'ok', input };
      },
    });

    const input = {
      approved: '{{approval_result}}',
      occurred_at: '{{run_timestamp}}',
    };
    await expect(actuator.dispatch('approve', input)).resolves.toMatchObject({
      ok: true,
      output: {
        status: 'ok',
        input: {
          steps: [{ type: 'apply', op: 'approve', params: input }],
        },
      },
    });
    expect((seen[0] as { steps: Array<{ params: unknown }> }).steps[0]?.params).toBe(input);
  });

  it('runs domain steps through one ordered preflight and context boundary', async () => {
    const observed: string[] = [];
    const unregister = registerOpPreflightListener({
      id: 'test:actuator-sdk-pipeline-repair',
      order: -100,
      run: (call, input) => {
        observed.push(`${call.op}:${String(input.value)}`);
        return { repaired_input: { value: `${String(input.value)}-repaired` } };
      },
    });
    try {
      const result = await runActuatorPipeline({
        actuatorId: 'demo',
        steps: [
          { op: 'first', params: { value: 'one' } },
          { op: 'second', params: { value: '{{previous}}' } },
        ],
        context: {},
        resolveParams: (params, context) => ({
          ...params,
          value: params.value === '{{previous}}' ? context.previous : params.value,
        }),
        execute: async (op, params, context) => ({
          ...context,
          previous: `${op}:${String(params.value)}`,
        }),
      });
      expect(observed).toEqual(['demo:first:one', 'demo:second:first:one-repaired']);
      expect(result).toEqual({ previous: 'second:first:one-repaired-repaired' });
    } finally {
      unregister();
    }
  });

  it('enforces in-process pipeline bounds before admitting the next handler', async () => {
    const execute = vi.fn(async (_op: string, context: Record<string, unknown>) => context);

    await expect(
      runActuatorPipeline({
        actuatorId: 'bounded',
        steps: [
          { op: 'first', params: {} },
          { op: 'second', params: {} },
        ],
        context: {},
        maxSteps: 1,
        execute,
      })
    ).rejects.toThrow('[SAFETY_LIMIT] Exceeded maximum pipeline steps (1)');
    expect(execute).toHaveBeenCalledTimes(1);

    await expect(
      runActuatorPipeline({
        actuatorId: 'timed',
        steps: [{ op: 'never-admitted', params: {} }],
        context: {},
        timeoutMs: -1,
        execute,
      })
    ).rejects.toThrow('[SAFETY_LIMIT] Pipeline execution timed out (-1ms)');
  });

  it('exposes the shared ADF engine controls without changing its result envelope', async () => {
    const steps = [
      { type: 'transform' as const, op: 'uppercase', params: { value: 'hello' } },
      { type: 'apply' as const, op: 'store', params: {} },
    ];
    const observed: string[] = [];
    const result = await runAdfActuatorPipeline({
      actuatorId: 'demo-adf',
      steps,
      context: {},
      options: {
        stepGate: async (step) => {
          observed.push(step.op);
        },
      },
      handlers: {
        capture: async (_op, _params, context) => context,
        transform: async (_op, params, context) => ({
          ...context,
          value: String(params.value).toUpperCase(),
        }),
        apply: async (_op, _params, context) => ({
          ...context,
          stored: context.value,
        }),
      },
    });

    expect(result).toMatchObject({
      status: 'succeeded',
      results: [
        { op: 'uppercase', status: 'success' },
        { op: 'store', status: 'success' },
      ],
      context: { value: 'HELLO', stored: 'HELLO' },
      total_steps: 2,
    });
    expect(observed).toEqual(['uppercase', 'store']);
  });

  it('does not execute a step when shared preflight blocks it', async () => {
    const execute = vi.fn();
    const unregister = registerOpPreflightListener({
      id: 'test:actuator-sdk-pipeline-block',
      order: -100,
      run: () => ({ decision: 'block', reason: 'blocked by test policy' }),
    });
    try {
      await expect(
        runActuatorPipeline({
          actuatorId: 'demo',
          steps: [{ op: 'blocked', params: {} }],
          context: {},
          execute,
        })
      ).rejects.toThrow('[OP_PREFLIGHT_BLOCK] blocked by test policy');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('applies the resolved sandbox policy to non-ADF domain handlers too', async () => {
    const policy = resolveSandboxPolicy({
      provider: 'codex',
      mode: 'workspace-write',
      networkAccess: false,
    });
    await expect(
      runActuatorPipeline({
        actuatorId: 'demo',
        steps: [{ op: 'network', params: {} }],
        context: {},
        sandboxPolicy: policy,
        execute: async () => {
          validateUrl('https://example.com');
          return {};
        },
      })
    ).rejects.toThrow('SANDBOX_NETWORK_DENIED');
  });

  it('honors approval metadata and fails closed without a trusted grant', async () => {
    const execute = vi.fn();
    await expect(
      runActuatorPipeline({
        actuatorId: 'demo',
        steps: [{ op: 'mutate', params: { _approval_required: true } }],
        context: {},
        execute,
      })
    ).rejects.toThrow('[OP_PREFLIGHT_ASK]');
    expect(execute).not.toHaveBeenCalled();

    const result = await runActuatorPipeline({
      actuatorId: 'demo',
      steps: [{ op: 'mutate', params: { value: 'approved', _approval_required: true } }],
      context: {},
      approvalGranted: () => true,
      hasHuman: true,
      execute: async (_op, params) => ({ result: params.value }),
    });
    expect(result).toEqual({ result: 'approved' });
  });

  it('shares ordered sequence accounting and stops after the first failed step', async () => {
    const executed: string[] = [];
    const errors: string[] = [];
    const result = await runActuatorStepSequence({
      actuatorId: 'demo',
      steps: [
        { op: 'first', params: {} },
        { op: 'second', params: {} },
        { op: 'unreached', params: {} },
      ],
      context: { count: 0 },
      onStepError: (step, error) => {
        errors.push(`${step.op}:${error instanceof Error ? error.message : String(error)}`);
      },
      execute: async (op, _params, context) => {
        executed.push(op);
        if (op === 'second') throw new Error('second failed');
        return { count: context.count + 1 };
      },
    });

    expect(result).toEqual({
      status: 'failed',
      results: [
        { op: 'first', status: 'success' },
        { op: 'second', status: 'failed', error: 'second failed' },
      ],
      context: { count: 1 },
    });
    expect(executed).toEqual(['first', 'second']);
    expect(errors).toEqual(['second:second failed']);
  });

  it('rejects a sequence that exceeds its declared step budget', async () => {
    await expect(
      runActuatorStepSequence({
        actuatorId: 'demo',
        steps: [
          { op: 'first', params: {} },
          { op: 'second', params: {} },
        ],
        context: {},
        maxSteps: 1,
        execute: async (_op, context) => context,
      })
    ).rejects.toThrow('[SAFETY_LIMIT] Exceeded maximum pipeline steps (1)');

    await expect(
      runActuatorStepSequence({
        actuatorId: 'demo',
        steps: [{ op: 'timed', params: {} }],
        context: {},
        timeoutMs: -1,
        execute: async (_op, context) => context,
      })
    ).rejects.toThrow('[SAFETY_LIMIT] Pipeline execution timed out (-1ms)');
  });
});
