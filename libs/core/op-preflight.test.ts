import { afterEach, describe, expect, it } from 'vitest';
import { withPluginExecutionFrame } from './sandbox-policy.js';
import {
  PLUGIN_GRANT_OPS_GUARD_ID,
  registerOpGuard,
  registerOpPreflightListener,
  resetOpPreflight,
  runOpPreflight,
  runOpPreflightSync,
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
    expect(result).toMatchObject({
      decision: 'allow',
      repaired_input: { value: 'normalized' },
      input: { value: 'normalized' },
    });
  });

  it('reports an allowed repair and preserves terminate metadata', async () => {
    registerOpPreflightListener({
      id: 'scope-normalizer',
      run: () => ({ repaired_input: { tenant: 'acme' }, terminate: true }),
    });
    const result = await runOpPreflight({
      op: 'service:read',
      params: { path: '/data' },
      source: 'mcp',
    });
    expect(result).toMatchObject({
      decision: 'allow',
      repaired_input: { path: '/data', tenant: 'acme' },
      terminate: true,
    });
  });

  it('includes repaired input when a repair listener later blocks', async () => {
    registerOpPreflightListener({
      id: 'repair',
      order: 10,
      run: () => ({ repaired_input: { tenant: 'acme' } }),
    });
    registerOpPreflightListener({
      id: 'deny',
      order: 20,
      run: () => ({ decision: 'block', reason: 'policy' }),
    });
    const result = await runOpPreflight({
      op: 'service:write',
      params: {},
      source: 'pipeline',
    });
    expect(result).toMatchObject({
      decision: 'block',
      repaired_input: { tenant: 'acme' },
      reason: 'policy',
    });
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

  it('blocks a human-gated operation at a non-interactive boundary', async () => {
    const result = await runOpPreflight({
      op: 'service:preset',
      params: {},
      source: 'pipeline',
      requiresApproval: true,
      approvalGranted: false,
      hasHuman: false,
    });
    expect(result).toMatchObject({
      decision: 'block',
      reason: expect.stringContaining('[HUMAN_REQUIRED]'),
      guard_ids: ['builtin:approval'],
    });
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

  it('supports synchronous admission for non-yielding command boundaries', () => {
    registerOpPreflightListener({
      id: 'sync-repair',
      run: () => ({ repaired_input: { admitted: true } }),
    });
    const result = runOpPreflightSync({
      op: 'render:cancel',
      params: {},
      source: 'actuator',
    });
    expect(result).toMatchObject({
      decision: 'allow',
      repaired_input: { admitted: true },
      input: { admitted: true },
    });
  });

  describe('plugin-grant-ops guard (EP-03)', () => {
    const frame = (ops: string[]) => ({
      pluginId: 'grant-plugin',
      grant: {
        network: { mode: 'none' as const, hosts: [] },
        fs: { mode: 'none' as const, paths: [] },
        ops_invoke: ops,
        env: [],
        secrets: [],
      },
    });

    it('blocks ops outside the executing plugin grant before any listener runs', async () => {
      const seen: string[] = [];
      registerOpPreflightListener({ id: 'observe', run: (call) => void seen.push(call.op) });
      const result = await withPluginExecutionFrame(frame(['demo:allowed']), () =>
        runOpPreflight({ op: 'demo:denied', params: {}, source: 'pipeline' })
      );
      expect(result).toMatchObject({
        decision: 'block',
        terminate: true,
        guard_ids: [PLUGIN_GRANT_OPS_GUARD_ID],
      });
      expect(result.reason).toContain(
        "[PLUGIN_GRANT_DENIED] plugin 'grant-plugin' is not granted ops_invoke 'demo:denied'"
      );
      expect(seen).toEqual([]);

      const allowed = await withPluginExecutionFrame(frame(['demo:allowed']), () =>
        runOpPreflight({ op: 'demo:allowed', params: {}, source: 'pipeline' })
      );
      expect(allowed.decision).toBe('allow');
      expect(seen).toEqual(['demo:allowed']);
    });

    it("allows any op for '*', applies to the sync path, and survives resetOpPreflight", () => {
      resetOpPreflight();
      expect(
        withPluginExecutionFrame(frame(['*']), () =>
          runOpPreflightSync({ op: 'any:op', params: {}, source: 'actuator' })
        ).decision
      ).toBe('allow');
      expect(
        withPluginExecutionFrame(frame([]), () =>
          runOpPreflightSync({ op: 'any:op', params: {}, source: 'actuator' })
        ).decision
      ).toBe('block');
      expect(runOpPreflightSync({ op: 'any:op', params: {}, source: 'actuator' }).decision).toBe(
        'allow'
      );
    });
  });
});
