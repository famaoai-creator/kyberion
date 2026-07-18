import { describe, expect, it } from 'vitest';
import {
  executeProgrammaticToolCall,
  resolveProgrammaticToolGrant,
} from './programmatic-tool-calling.js';
import { pathResolver } from './path-resolver.js';

function sourceRunner() {
  return {
    command: process.execPath,
    args: [
      '--import',
      pathResolver.rootResolve('scripts/ts-loader.mjs'),
      pathResolver.rootResolve('scripts/programmatic_tool_runner.ts'),
    ],
    cwd: pathResolver.rootDir(),
  };
}

describe('programmatic-tool-calling', () => {
  it('enforces sandbox allowlist ∩ session grant', () => {
    expect(
      resolveProgrammaticToolGrant(
        ['system:read_file', 'system:write_file', 'system:read_json'],
        ['system:read_file', 'system:write_file']
      )
    ).toEqual(['system:read_file']);
    expect(resolveProgrammaticToolGrant(['system:read_file'], [])).toEqual([]);
  });

  it('returns stdout only while intermediate typed-op results stay in the child', async () => {
    const events: Array<{ op: string; status: string }> = [];
    const result = await executeProgrammaticToolCall({
      runner: sourceRunner(),
      request: {
        code: `
          const first = await callOp('system:read_file', { path: 'first' });
          const second = await callOp('system:read_file', { path: first.path });
          console.log(JSON.stringify({ final: second.value }));
        `,
        allowed_ops: ['system:read_file'],
        granted_ops: ['system:read_file'],
      },
      invoke: async ({ params }) => ({ path: String(params.path), value: 'typed-result' }),
      on_call: (event) => events.push({ op: event.op, status: event.status }),
    });

    expect(result.stdout).toBe('{"final":"typed-result"}');
    expect(result.calls).toBe(2);
    expect(events).toEqual([
      { op: 'system:read_file', status: 'allowed' },
      { op: 'system:read_file', status: 'succeeded' },
      { op: 'system:read_file', status: 'allowed' },
      { op: 'system:read_file', status: 'succeeded' },
    ]);
  });

  it('rejects out-of-intersection calls before invoking the typed-op callback', async () => {
    let invoked = false;
    await expect(
      executeProgrammaticToolCall({
        runner: sourceRunner(),
        request: {
          code: `await callOp('system:write_file', { path: 'x', content: 'no' });`,
          allowed_ops: ['system:write_file'],
          granted_ops: ['system:write_file'],
        },
        invoke: async () => {
          invoked = true;
          return null;
        },
      })
    ).rejects.toThrow(/allowed_ops ∩ granted_ops is empty/);
    expect(invoked).toBe(false);
  });

  it('records a denied call at the parent policy gate', async () => {
    const events: Array<{ op: string; status: string }> = [];
    await expect(
      executeProgrammaticToolCall({
        runner: sourceRunner(),
        request: {
          code: `await callOp('system:write_file', { path: 'x', content: 'no' });`,
          allowed_ops: ['system:read_file'],
          granted_ops: ['system:read_file'],
        },
        invoke: async () => {
          throw new Error('must not invoke denied op');
        },
        on_call: (event) => events.push({ op: event.op, status: event.status }),
      })
    ).rejects.toThrow(/outside allowed_ops/);
    expect(events).toEqual([{ op: 'system:write_file', status: 'denied' }]);
  });

  it('stops at the call limit and reports the bounded failure', async () => {
    await expect(
      executeProgrammaticToolCall({
        runner: sourceRunner(),
        request: {
          code: `
            await callOp('system:read_file', {});
            await callOp('system:read_file', {});
            await callOp('system:read_file', {});
          `,
          allowed_ops: ['system:read_file'],
          granted_ops: ['system:read_file'],
          max_calls: 2,
        },
        invoke: async () => null,
      })
    ).rejects.toThrow(/call limit exceeded/);
  });

  it('stops a slow typed-op call at the timeout boundary', async () => {
    await expect(
      executeProgrammaticToolCall({
        runner: sourceRunner(),
        request: {
          code: `await callOp('system:read_file', {});`,
          allowed_ops: ['system:read_file'],
          granted_ops: ['system:read_file'],
          timeout_ms: 25,
        },
        invoke: async () => new Promise((resolve) => setTimeout(() => resolve('late'), 100)),
      })
    ).rejects.toThrow(/op timeout|script timeout/);
  });
});
