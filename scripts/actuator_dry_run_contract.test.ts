import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { createStandardYargs, runActuatorCli } from '@agent/core/cli-utils';
import { buildKyberionRunNodeArgs } from './cli.js';
import { runPlayground } from './actuator_playground.js';

const TMP_DIR = pathResolver.sharedTmp('actuator-dry-run-contract');

afterEach(() => {
  try {
    safeRmSync(TMP_DIR);
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

async function runCliDryRun(fileName: string, payload: Record<string, unknown>) {
  safeMkdir(TMP_DIR, { recursive: true });
  const inputPath = path.join(TMP_DIR, fileName);
  safeWriteFile(inputPath, JSON.stringify(payload));
  const handleAction = vi.fn(async () => ({ mutated: true }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await runActuatorCli({
    name: 'contract-actuator',
    args: ['node', 'script', '--input', inputPath, '--dry-run'],
    handleAction,
  });
  return handleAction;
}

describe('actuator --dry-run contract across public entry paths', () => {
  it('createStandardYargs parses --dry-run for the shared CLI boundary', async () => {
    const argv = await createStandardYargs([
      'node',
      'script',
      '--input',
      'in.json',
      '--dry-run',
    ]).parse();
    expect(argv.dryRun).toBe(true);
  });

  it('runActuatorCli / createStandardYargs: capture executes, apply/transform/control do not', async () => {
    safeMkdir(TMP_DIR, { recursive: true });
    const capturePath = path.join(TMP_DIR, 'capture.json');
    safeWriteFile(capturePath, JSON.stringify({ action: 'get', params: { name: 'x' } }));
    const captureHandler = vi.fn(async () => ({ captured: true }));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runActuatorCli({
      name: 'contract-actuator',
      args: ['node', 'script', '--input', capturePath, '--dry-run'],
      handleAction: captureHandler,
    });
    expect(captureHandler).toHaveBeenCalledTimes(1);

    const applyHandler = await runCliDryRun('apply.json', { action: 'set', params: { name: 'x' } });
    const transformHandler = await runCliDryRun('transform.json', {
      kind: 'transform',
      action: 'reshape',
      params: {},
    });
    const controlHandler = await runCliDryRun('control.json', {
      kind: 'control',
      action: 'steer',
      params: {},
    });
    expect(applyHandler).not.toHaveBeenCalled();
    expect(transformHandler).not.toHaveBeenCalled();
    expect(controlHandler).not.toHaveBeenCalled();
  });

  it('playground: capture --dry-run invokes the actuator; apply/transform/control do not', async () => {
    const executeActuator = vi.fn(() => '{"ok":true}');
    const seams = {
      dryRun: true,
      json: true,
      quiet: true,
      resolveExecutable: () => '/tmp/fake-secret-actuator.js',
      executeActuator,
    } as const;

    const capture = await runPlayground(
      ['--actuator', 'secret-actuator', '--op', 'get', '--params', '{"service":"s","account":"a"}'],
      { ...seams }
    );
    expect(executeActuator).toHaveBeenCalledWith(
      expect.objectContaining({ extraArgs: ['--dry-run'] })
    );
    expect(capture?.handler_invoked).toBe(true);

    executeActuator.mockClear();
    const apply = await runPlayground(
      ['--actuator', 'secret-actuator', '--op', 'set', '--params', '{"service":"s","account":"a"}'],
      { ...seams }
    );
    expect(executeActuator).not.toHaveBeenCalled();
    expect(apply?.handler_invoked).toBe(false);
    expect(apply?.handler).toBe('skipped');
    expect(apply?.kind).toBe('apply');

    const transform = await runPlayground(
      [
        '--actuator',
        'ingest-actuator',
        '--op',
        'normalize_card',
        '--params',
        '{"path":"knowledge/public/x.md"}',
      ],
      { ...seams, resolveExecutable: () => '/tmp/fake-ingest-actuator.js' }
    );
    expect(executeActuator).not.toHaveBeenCalled();
    expect(transform?.handler_invoked).toBe(false);
    expect(transform?.handler).toBe('skipped');

    const control = await runPlayground(
      ['--actuator', 'process-actuator', '--op', 'stop', '--params', '{"process_id":"p1"}'],
      { ...seams, resolveExecutable: () => '/tmp/fake-process-actuator.js' }
    );
    expect(executeActuator).not.toHaveBeenCalled();
    expect(control?.handler_invoked).toBe(false);
    expect(control?.handler).toBe('skipped');
  });

  it('playground --check never invokes handlers, including capture', async () => {
    const executeActuator = vi.fn(() => '{"ok":true}');
    const checked = await runPlayground(
      ['--actuator', 'secret-actuator', '--op', 'get', '--params', '{"service":"s","account":"a"}'],
      {
        check: true,
        json: true,
        quiet: true,
        resolveExecutable: () => '/tmp/fake-secret-actuator.js',
        executeActuator,
      }
    );
    expect(executeActuator).not.toHaveBeenCalled();
    expect(checked?.handler_invoked).toBe(false);
    expect(checked?.mode).toBe('check');
  });

  it('pnpm kyberion run forwards --dry-run to the compiled actuator argv', () => {
    const argv = buildKyberionRunNodeArgs('dist/libs/actuators/secret-actuator/src/index.js', [
      '--input',
      'active/shared/tmp/in.json',
      '--dry-run',
    ]);
    expect(argv).toEqual([
      'dist/libs/actuators/secret-actuator/src/index.js',
      '--input',
      'active/shared/tmp/in.json',
      '--dry-run',
    ]);
  });
});
