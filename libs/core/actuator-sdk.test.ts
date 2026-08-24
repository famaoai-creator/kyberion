import { describe, expect, it } from 'vitest';
import { defineActuator } from './actuator-sdk.js';

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
});
