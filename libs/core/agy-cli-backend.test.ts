import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { AgyCliBackend, buildAgyCliBackendFromEnv } from './agy-cli-backend.js';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

function createChild(stdoutText: string, stderrText = '', exitCode = 0): any {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();

  queueMicrotask(() => {
    if (stdoutText) child.stdout.write(stdoutText);
    child.stdout.end();
    if (stderrText) child.stderr.write(stderrText);
    child.stderr.end();
    child.emit('close', exitCode);
  });

  return child;
}

describe('agy-cli-backend', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.KYBERION_AGY_CLI_BIN;
    delete process.env.KYBERION_AGY_CLI_MODEL;
    delete process.env.KYBERION_AGY_CLI_TIMEOUT_MS;
    delete process.env.KYBERION_AGY_CLI_LOG_FILE;
    delete process.env.KYBERION_AGY_SANDBOX;
  });

  it('builds from env when agy cli settings are configured', () => {
    process.env.KYBERION_AGY_CLI_BIN = 'agy';
    process.env.KYBERION_AGY_CLI_MODEL = 'agy';
    process.env.KYBERION_AGY_SANDBOX = '1';

    const backend = buildAgyCliBackendFromEnv();

    expect(backend?.name).toBe('agy-cli');
  });

  it('runs print mode with the current agy cli flags and parses JSON output', async () => {
    spawnMock.mockReturnValueOnce(
      createChild(JSON.stringify({ response: '{"ok":true}' })),
    );

    const backend = new AgyCliBackend({
      bin: 'agy',
      model: 'agy',
      sandbox: true,
      logFile: '/tmp/agy-cli.log',
    });

    const result = await backend.prompt('Return JSON: {"ok":true}');

    expect(result).toBe('{"ok":true}');
    expect(spawnMock).toHaveBeenCalledWith(
      'agy',
      expect.arrayContaining([
        '--log-file',
        '/tmp/agy-cli.log',
        '--model',
        'agy',
        '--sandbox',
        '--dangerously-skip-permissions',
        '-p',
        'Return JSON: {"ok":true}',
      ]),
      expect.any(Object),
    );
    expect(spawnMock.mock.calls[0][1]).not.toContain('--output-format');
    expect(spawnMock.mock.calls[0][1]).not.toContain('--json-schema');
    expect(spawnMock.mock.calls[0][1]).not.toContain('--system-prompt');
  });

  it('runs structured mode by requesting json in the prompt and validates the response', async () => {
    spawnMock.mockReturnValueOnce(
      createChild('```json\n{"goal":"ship","constraints":[],"deliverables":[],"excluded":[],"stakeholders":[]}\n```'),
    );

    const backend = new AgyCliBackend({
      bin: 'agy',
      model: 'agy',
      sandbox: true,
      logFile: '/tmp/agy-cli.log',
    });

    const result = await backend.runStructured({
      systemPrompt: 'Extract intent.',
      userPrompt: 'please ship this',
      schema: z.object({
        goal: z.string(),
        constraints: z.array(z.string()),
        deliverables: z.array(z.string()),
        excluded: z.array(z.string()),
        stakeholders: z.array(z.string()),
      }),
    });

    expect(result).toMatchObject({ goal: 'ship' });
  });
});
