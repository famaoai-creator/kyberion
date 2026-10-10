import { describe, expect, it, vi } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import * as discovery from '@agent/core/actuator/actuator-op-discovery';
import {
  actuatorAcceptsPipeline,
  buildPipelineWrappedPayload,
  buildPlaygroundPayload,
  evaluatePlaygroundDryRun,
  lookupDiscoveryOpKind,
  parsePlaygroundParams,
  resolvePlaygroundCapabilities,
  runPlayground,
} from './actuator_playground.js';

describe('actuator playground JSON input boundary', () => {
  it('builds the canonical actuator payload for machine execution', () => {
    expect(buildPlaygroundPayload('send', { channel: 'slack', text: 'hello' })).toEqual({
      action: 'send',
      op: 'send',
      params: { channel: 'slack', text: 'hello' },
    });
  });

  it('accepts an object parameter payload without coercion', () => {
    expect(parsePlaygroundParams('{"count":2,"enabled":true}')).toEqual({
      count: 2,
      enabled: true,
    });
  });

  it.each(['[]', 'null', '"text"'])('rejects non-object parameters %s', (raw) => {
    expect(() => parsePlaygroundParams(raw)).toThrow('--params must be a JSON object');
  });

  it('keeps interactive output behind the injected printer boundary', () => {
    const source = String(safeReadFile(pathResolver.rootResolve('scripts/actuator_playground.ts')));

    expect(source).toContain('print?: Print');
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
  });

  it('evaluates the actuator dry-run contract without side effects', () => {
    expect(
      evaluatePlaygroundDryRun({
        actuatorId: 'secret-actuator',
        operation: 'get',
        payload: buildPlaygroundPayload('get', { service: 'slack', account: 'bot' }),
      })
    ).toMatchObject({
      ok: true,
      kind: 'capture',
      handler: 'capture',
      validated: true,
    });
    expect(
      evaluatePlaygroundDryRun({
        actuatorId: 'secret-actuator',
        operation: 'set',
        payload: buildPlaygroundPayload('set', { service: 'slack', account: 'bot' }),
      })
    ).toMatchObject({
      ok: true,
      kind: 'apply',
      handler: 'skipped',
      dry_run: true,
    });
  });

  it('invokes capture handlers under playground --dry-run and skips apply', async () => {
    const executeActuator = vi.fn(() => '{"status":"captured"}');
    const capture = await runPlayground(
      ['--actuator', 'secret-actuator', '--op', 'get', '--params', '{"service":"s","account":"a"}'],
      {
        dryRun: true,
        json: true,
        quiet: true,
        resolveExecutable: () => '/tmp/fake-secret-actuator.js',
        executeActuator,
      }
    );
    expect(executeActuator).toHaveBeenCalledWith(
      expect.objectContaining({ extraArgs: ['--dry-run'] })
    );
    expect(capture).toMatchObject({
      handler_invoked: true,
      kind: 'capture',
      mode: 'dry-run',
    });

    executeActuator.mockClear();
    const apply = await runPlayground(
      ['--actuator', 'secret-actuator', '--op', 'set', '--params', '{"service":"s","account":"a"}'],
      {
        dryRun: true,
        json: true,
        quiet: true,
        resolveExecutable: () => '/tmp/fake-secret-actuator.js',
        executeActuator,
      }
    );
    expect(executeActuator).not.toHaveBeenCalled();
    expect(apply).toMatchObject({
      handler: 'skipped',
      handler_invoked: false,
      kind: 'apply',
    });
  });

  it('rejects dangerous nested keys before actuator execution', () => {
    expect(() => parsePlaygroundParams('{"params":{"__proto__":{"polluted":true}}}')).toThrow(
      '--params contains a dangerous JSON key'
    );
  });

  it('blocks live secret-actuator set with a value', async () => {
    await expect(
      runPlayground(
        [
          '--actuator',
          'secret-actuator',
          '--op',
          'set',
          '--params',
          '{"service":"s","account":"a","value":"secret"}',
        ],
        {
          json: true,
          quiet: true,
          resolveExecutable: () => '/tmp/fake-secret-actuator.js',
          executeActuator: vi.fn(() => '{"status":"ok"}'),
        }
      )
    ).rejects.toThrow(/PLAYGROUND_SECRET_SET_BLOCKED/);
  });
});

describe('actuator playground discovery merge and pipeline wrap', () => {
  it('reports the actual apply handler for live mutations', async () => {
    const result = await runPlayground(
      [
        '--actuator',
        'file-actuator',
        '--op',
        'write',
        '--params',
        '{"path":"active/shared/tmp/test.txt","content":"hello"}',
      ],
      {
        json: true,
        resolveExecutable: () => '/tmp/fake-file.js',
        executeActuator: () => '{"status":"succeeded"}',
      }
    );
    expect(result).toMatchObject({
      ok: true,
      kind: 'apply',
      handler: 'apply',
      handler_invoked: true,
    });
  });

  it('returns structured failure evidence when the actuator process fails', async () => {
    const result = await runPlayground(
      ['--actuator', 'browser-actuator', '--op', 'snapshot', '--params', '{}'],
      {
        json: true,
        resolveExecutable: () => '/tmp/fake-browser.js',
        executeActuator: () => {
          throw Object.assign(new Error('browser failed'), { stdout: '{"status":"failed"}' });
        },
      }
    );
    expect(result).toMatchObject({
      ok: false,
      handler_invoked: true,
      error: 'browser failed',
      stdout: '{"status":"failed"}',
    });
  });
  it('stops before execution when the discovery catalog cannot be loaded', async () => {
    const executeActuator = vi.fn();
    const loader = vi.spyOn(discovery, 'loadActuatorOpDiscoveryAtPath').mockImplementation(() => {
      throw new Error('Invalid catalog');
    });
    try {
      await expect(
        runPlayground(['--actuator', 'agent-actuator', '--op', 'snapshot', '--params', '{}'], {
          json: true,
          executeActuator,
        })
      ).rejects.toThrow('Invalid catalog');
      expect(executeActuator).not.toHaveBeenCalled();
    } finally {
      loader.mockRestore();
    }
  });
  it('describes an operation schema without invoking or resolving an executable', async () => {
    const executeActuator = vi.fn();
    const resolveExecutable = vi.fn();
    const result = await runPlayground(
      ['--actuator', 'file-actuator', '--op', 'read', '--describe'],
      { json: true, executeActuator, resolveExecutable }
    );
    expect(result).toMatchObject({ mode: 'describe', handler_invoked: false });
    expect(result?.actuators).toEqual([
      expect.objectContaining({
        ops: [expect.objectContaining({ op: 'read', input_schema: expect.any(Object) })],
      }),
    ]);
    expect(executeActuator).not.toHaveBeenCalled();
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it('filters operation discovery and fails explicitly on unknown selections', async () => {
    const result = await runPlayground(
      ['--actuator', 'file-actuator', '--list', '--search', 'read'],
      { json: true }
    );
    expect(result?.actuators).toEqual([
      expect.objectContaining({
        ops: expect.arrayContaining([expect.objectContaining({ op: 'read' })]),
      }),
    ]);
    await expect(
      runPlayground(['--actuator', 'missing', '--list'], { json: true })
    ).rejects.toThrow('Unknown --actuator');
    await expect(
      runPlayground(['--actuator', 'file-actuator', '--op', 'missing', '--describe'], {
        json: true,
      })
    ).rejects.toThrow('Unknown --op');
    await expect(runPlayground(['--describe'], { json: true })).rejects.toThrow(
      '--describe requires'
    );
  });

  it('rejects missing fine-grained parameters before checking or executing a handler', async () => {
    const executeActuator = vi.fn();
    const args = ['--actuator', 'agent-actuator', '--op', 'snapshot', '--params', '{}'];
    const result = await runPlayground(args, { json: true, check: true, executeActuator });
    expect(result).toMatchObject({
      ok: false,
      validated: false,
      parameter_validation: 'authored-schema',
      handler_invoked: false,
    });
    await expect(runPlayground(args, { json: true, executeActuator })).rejects.toThrow(
      'Invalid parameters'
    );
    expect(executeActuator).not.toHaveBeenCalled();
  });

  it('requires an explicit fill value while preserving clear and secret inputs', async () => {
    const executeActuator = vi.fn();
    for (const params of [{ ref: '@e1' }, { ref: '@e1', secret_ref: '' }]) {
      const result = await runPlayground(
        ['--actuator', 'browser-actuator', '--op', 'fill_ref', '--params', JSON.stringify(params)],
        { json: true, check: true, executeActuator }
      );
      expect(result).toMatchObject({ ok: false, handler_invoked: false });
    }
    for (const params of [
      { ref: '@e1', text: '' },
      { ref: '@e1', secret_ref: 'TOKEN' },
      { ref: '@e1', classification: 'secret_ref', variable: { name: 'TOKEN' } },
    ]) {
      const result = await runPlayground(
        ['--actuator', 'browser-actuator', '--op', 'fill_ref', '--params', JSON.stringify(params)],
        { json: true, check: true, executeActuator }
      );
      expect(result).toMatchObject({ ok: true, handler_invoked: false });
    }
    expect(executeActuator).not.toHaveBeenCalled();
  });

  it('labels unavailable parameter validation honestly', () => {
    expect(
      evaluatePlaygroundDryRun({
        actuatorId: 'legacy',
        operation: 'read',
        payload: {},
        inputSchema: { 'x-kyberion-contract': 'legacy-open' },
      })
    ).toMatchObject({ parameter_validation: 'not-available' });
  });

  it('merges describeOps step ops into manifest capabilities', () => {
    const caps = resolvePlaygroundCapabilities(
      {
        actuator_id: 'file-actuator',
        version: '1.1.0',
        capabilities: [{ op: 'pipeline', platforms: [] }],
      },
      'file-actuator'
    );
    const ops = (caps || []).map((capability) => capability.op);
    expect(ops).toContain('pipeline');
    expect(ops).toContain('read');
  });

  it('wraps a single discovery op into the ADF one-step pipeline shape', () => {
    expect(buildPipelineWrappedPayload('read', { path: 'package.json' }, 'capture')).toEqual({
      action: 'pipeline',
      op: 'pipeline',
      steps: [{ type: 'capture', op: 'read', params: { path: 'package.json' } }],
      context: {},
      options: {},
    });
  });

  it('only wraps actuators that accept pipeline payloads', () => {
    expect(
      actuatorAcceptsPipeline({
        actuator_id: 'file-actuator',
        version: '1.1.0',
        capabilities: [{ op: 'pipeline', platforms: [] }],
      })
    ).toBe(true);
    expect(
      actuatorAcceptsPipeline({
        actuator_id: 'secret-actuator',
        version: '1.2.0',
        capabilities: [
          { op: 'get', platforms: [] },
          { op: 'set', platforms: [] },
        ],
      })
    ).toBe(false);
  });

  it('resolves discovery op kinds for wrapped payload typing', () => {
    expect(lookupDiscoveryOpKind('file-actuator', 'read', 'file-actuator')).toBe('capture');
    expect(lookupDiscoveryOpKind('file-actuator', 'no-such-op', 'file-actuator')).toBeNull();
  });
});
