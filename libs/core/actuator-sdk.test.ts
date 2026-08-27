import { describe, expect, it } from 'vitest';
import {
  defineActuator,
  defineCatalogBackedActuator,
  defineLegacyPipelineActuator,
  withCatalogInputContract,
} from './actuator-sdk.js';

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
});
