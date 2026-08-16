import { afterEach, describe, expect, it } from 'vitest';
import {
  registerOpGuard,
  registerOpPreflightListener,
  resetOpPreflight,
  runOpPreflight,
} from './op-preflight.js';

describe('op preflight waterfall', () => {
  afterEach(() => resetOpPreflight());

  it('runs listeners serially and allows a later listener to repair input', async () => {
    const order: string[] = [];
    registerOpPreflightListener({
      id: 'normalize',
      order: 10,
      run: (_call, input) => {
        order.push(`normalize:${String(input.value)}`);
        return { repaired_input: { value: 'normalized' } };
      },
    });
    registerOpPreflightListener({
      id: 'observe',
      order: 20,
      run: (_call, input) => order.push(`observe:${String(input.value)}`),
    });

    const result = await runOpPreflight({
      op: 'demo:op',
      params: { value: 'raw' },
      source: 'pipeline',
    });
    expect(order).toEqual(['normalize:raw', 'observe:normalized']);
    expect(result).toMatchObject({ decision: 'allow', input: { value: 'normalized' } });
  });

  it('keeps a listener denial terminal and never executes guards after it', async () => {
    const guard = registerOpGuard({
      id: 'should-not-run',
      check: () => ({ decision: 'allow' as never }),
    });
    expect(guard).toEqual(expect.any(Function));
    registerOpPreflightListener({
      id: 'deny',
      run: () => ({ decision: 'block', reason: 'tenant scope denied' }),
    });
    const result = await runOpPreflight({ op: 'demo:op', params: {}, source: 'actuator' });
    expect(result).toMatchObject({
      decision: 'block',
      reason: 'tenant scope denied',
      guard_ids: [],
    });
  });

  it('uses the built-in approval guard before custom guards', async () => {
    registerOpGuard({ id: 'custom', check: () => ({ decision: 'block', reason: 'custom' }) });
    const result = await runOpPreflight({
      op: 'service:preset',
      params: {},
      source: 'pipeline',
      requiresApproval: true,
      approvalGranted: false,
    });
    expect(result).toMatchObject({ decision: 'ask', guard_ids: ['builtin:approval'] });
  });

  it('fails closed on duplicate registrations and permits disposal', async () => {
    const dispose = registerOpPreflightListener({ id: 'temporary', run: () => undefined });
    expect(() => registerOpPreflightListener({ id: 'temporary', run: () => undefined })).toThrow(
      'duplicate listener id'
    );
    dispose();
    const result = await runOpPreflight({ op: 'demo:op', params: {}, source: 'delegate' });
    expect(result.listener_ids).toEqual([]);
  });
});
