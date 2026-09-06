import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  createStandardYargs,
  normalizeActuatorServeRequest,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from './cli-utils.js';
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
  it('rejects malformed warm actuator requests before dispatch', () => {
    expect(() => normalizeActuatorServeRequest([])).toThrow(
      'actuator serve request must be a JSON object'
    );
    expect(() => normalizeActuatorServeRequest({ id: 42 })).toThrow(
      'actuator serve request.id must be a non-empty string'
    );
    expect(normalizeActuatorServeRequest({ id: 'r1', input: { action: 'check' } })).toEqual({
      id: 'r1',
      input: { action: 'check' },
    });
  });

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
    expect(argv.dryRun).toBe(false);
  });

  it('parses --dry-run', async () => {
    const argv = await createStandardYargs([
      'node',
      'script',
      '--input',
      'in.json',
      '--dry-run',
    ]).parse();
    expect(argv.dryRun).toBe(true);
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

  it('validates apply actions under --dry-run without calling handleAction', async () => {
    safeMkdir(TMP_DIR, { recursive: true });
    const inputPath = `${TMP_DIR}/apply.json`;
    safeWriteFile(inputPath, JSON.stringify({ action: 'set', params: { name: 'x' } }, null, 2));
    const handleAction = vi.fn(async () => ({ mutated: true }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runActuatorCli({
      name: 'test-actuator',
      args: ['node', 'script', '--input', inputPath, '--dry-run'],
      handleAction,
    });

    expect(handleAction).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        { dry_run: true, mode: 'validate-only', kind: 'apply', validated: true },
        null,
        2
      )
    );
  });

  it('still runs capture actions under --dry-run', async () => {
    safeMkdir(TMP_DIR, { recursive: true });
    const inputPath = `${TMP_DIR}/get.json`;
    safeWriteFile(inputPath, JSON.stringify({ action: 'get', params: { name: 'x' } }, null, 2));
    const handleAction = vi.fn(async (input) => ({ captured: input }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runActuatorCli({
      name: 'test-actuator',
      args: ['node', 'script', '--input', inputPath, '--dry-run'],
      handleAction,
    });

    expect(handleAction).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ captured: { action: 'get', params: { name: 'x' } } }, null, 2)
    );
  });

  it('reports invalid JSON input through the caller error boundary', async () => {
    safeMkdir(TMP_DIR, { recursive: true });
    const inputPath = `${TMP_DIR}/bad.json`;
    safeWriteFile(inputPath, '{"message":');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      runActuatorCli({
        name: 'test-actuator',
        args: ['node', 'script', '--input', inputPath],
        handleAction: async () => ({}),
      })
    ).rejects.toThrow('invalid JSON input');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[test-actuator] invalid JSON input:')
    );
  });

  it('reports schema violations through the caller error boundary', async () => {
    safeMkdir(TMP_DIR, { recursive: true });
    const inputPath = `${TMP_DIR}/schema.json`;
    safeWriteFile(inputPath, JSON.stringify({ message: 'missing action' }, null, 2));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    ).rejects.toThrow('invalid input');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[test-actuator] invalid input:')
    );
  });

  it('reports handleAction failures through the caller error boundary', async () => {
    safeMkdir(TMP_DIR, { recursive: true });
    const inputPath = `${TMP_DIR}/action.json`;
    safeWriteFile(inputPath, JSON.stringify({ message: 'boom' }, null, 2));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      runActuatorCli({
        name: 'test-actuator',
        args: ['node', 'script', '--input', inputPath],
        handleAction: async () => {
          throw new Error('boom');
        },
      })
    ).rejects.toThrow('handleAction failed');

    expect(errorSpy).toHaveBeenCalledWith('[test-actuator] handleAction failed: boom');
  });

  it('rejects input paths outside the repository root', async () => {
    const outsidePath = path.join(pathResolver.rootDir(), '..', 'cli-utils-outside.json');
    await expect(
      runActuatorCli({
        name: 'test-actuator',
        args: ['node', 'script', '--input', outsidePath],
        handleAction: async () => ({}),
      })
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('reports package-local entrypoint failures through the shared boundary', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runActuatorCliEntryPoint(async () => {
        throw new Error('entrypoint boom');
      }, 'test-actuator');
      expect(errorSpy).toHaveBeenCalledWith('[test-actuator] entrypoint boom');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
