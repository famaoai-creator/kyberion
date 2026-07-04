import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStandardYargs, runActuatorCli } from './cli-utils.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

const TMP_DIR = pathResolver.sharedTmp('cli-utils-test');

afterEach(() => {
  if (safeMkdir) {
    // no-op sentinel to keep import live in tests
  }
  if (safeRmSync && safeMkdir) {
    try {
      safeRmSync(TMP_DIR);
    } catch (_) {
      /* ignore */
    }
  }
  vi.restoreAllMocks();
});

describe('cli-utils', () => {
  it('parses standard options and defaults the tier', async () => {
    const argv = await createStandardYargs([
      'node',
      'script',
      '--input',
      'in.json',
      '--out',
      'out.json',
    ]).parse();

    expect(argv.input).toBe('in.json');
    expect(argv.out).toBe('out.json');
    expect(argv.tier).toBe('public');
  });

  it('accepts the short aliases', async () => {
    const argv = await createStandardYargs([
      'node',
      'script',
      '-i',
      'data.yaml',
      '-o',
      'data.json',
      '--tier',
      'confidential',
    ]).parse();

    expect(argv.input).toBe('data.yaml');
    expect(argv.out).toBe('data.json');
    expect(argv.tier).toBe('confidential');
  });

  it('runs the actuator CLI on valid JSON input', async () => {
    safeMkdir(TMP_DIR, { recursive: true });
    const inputPath = `${TMP_DIR}/input.json`;
    safeWriteFile(inputPath, JSON.stringify({ message: 'hello' }, null, 2));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runActuatorCli({
      name: 'test-actuator',
      args: ['node', 'script', '--input', inputPath],
      handleAction: async (input) => ({ echoed: input }),
    });

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ echoed: { message: 'hello' } }, null, 2));
  });

  it('reports invalid JSON input and exits with code 1', async () => {
    safeMkdir(TMP_DIR, { recursive: true });
    const inputPath = `${TMP_DIR}/bad.json`;
    safeWriteFile(inputPath, '{"message":');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as any);

    await expect(
      runActuatorCli({
        name: 'test-actuator',
        args: ['node', 'script', '--input', inputPath],
        handleAction: async () => ({}),
      })
    ).rejects.toThrow('exit:1');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[test-actuator] invalid JSON input:')
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('reports schema violations and exits with code 1', async () => {
    safeMkdir(TMP_DIR, { recursive: true });
    const inputPath = `${TMP_DIR}/schema.json`;
    safeWriteFile(inputPath, JSON.stringify({ message: 'missing action' }, null, 2));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as any);

    await expect(
      runActuatorCli({
        name: 'test-actuator',
        args: ['node', 'script', '--input', inputPath],
        schema: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { type: 'string' },
          },
        },
        handleAction: async () => ({}),
      })
    ).rejects.toThrow('exit:1');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[test-actuator] invalid input:')
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('reports handleAction failures and exits with code 1', async () => {
    safeMkdir(TMP_DIR, { recursive: true });
    const inputPath = `${TMP_DIR}/action.json`;
    safeWriteFile(inputPath, JSON.stringify({ message: 'boom' }, null, 2));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as any);

    await expect(
      runActuatorCli({
        name: 'test-actuator',
        args: ['node', 'script', '--input', inputPath],
        handleAction: async () => {
          throw new Error('boom');
        },
      })
    ).rejects.toThrow('exit:1');

    expect(errorSpy).toHaveBeenCalledWith('[test-actuator] handleAction failed: boom');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
