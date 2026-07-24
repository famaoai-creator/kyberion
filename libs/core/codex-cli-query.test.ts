import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { buildCodexCliQueryOptionsFromEnv, runCodexCliQuery } from './codex-cli-query.js';

const mocks = vi.hoisted(() => ({
  safeExecResult: vi.fn(),
  safeWriteFile: vi.fn(),
  safeReadFile: vi.fn(),
  safeRmSync: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return {
    ...actual,
    safeExecResult: mocks.safeExecResult,
    safeWriteFile: mocks.safeWriteFile,
    safeReadFile: mocks.safeReadFile,
    safeRmSync: mocks.safeRmSync,
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mocks.spawnMock };
});

function createChild(exitCode = 0): any {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();

  queueMicrotask(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit('close', exitCode);
  });

  return child;
}

describe('codex-cli-query', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    });
    mocks.safeExecResult.mockReturnValue({
      stdout: '/usr/local/bin/codex\n/Users/famao/kyberion/node_modules/.bin/codex',
      stderr: '',
      status: 0,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    });
    vi.clearAllMocks();
  });

  it('prefers a real codex executable over the repo-local shim', () => {
    const options = buildCodexCliQueryOptionsFromEnv({
      PATH: [
        '/usr/bin',
        '/bin',
        '/Users/famao/kyberion/node_modules/.bin',
        '/opt/homebrew/bin',
      ].join(':'),
    } as NodeJS.ProcessEnv);

    expect(options.bin).toBe('/usr/local/bin/codex');
  });

  it('keeps an explicit override when provided', () => {
    const options = buildCodexCliQueryOptionsFromEnv({
      PATH: '/usr/bin:/bin:/Users/famao/kyberion/node_modules/.bin:/opt/homebrew/bin',
      KYBERION_CODEX_CLI_BIN: '/custom/bin/codex',
    } as NodeJS.ProcessEnv);

    expect(options.bin).toBe('/custom/bin/codex');
  });

  describe('spawnCli env allowlisting (XP-02)', () => {
    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const previousUnrelated = process.env.UNRELATED_TEST_SECRET;

    beforeEach(() => {
      mocks.safeWriteFile.mockReset();
      mocks.safeReadFile.mockReset().mockReturnValue(JSON.stringify({ ok: true }));
      mocks.safeRmSync.mockReset();
      mocks.spawnMock.mockReset();
    });

    afterEach(() => {
      if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
      if (previousUnrelated === undefined) delete process.env.UNRELATED_TEST_SECRET;
      else process.env.UNRELATED_TEST_SECRET = previousUnrelated;
    });

    it('spawns codex with an allowlisted env that excludes other providers credentials', async () => {
      process.env.ANTHROPIC_API_KEY = 'fake-anthropic-key-should-not-leak';
      process.env.UNRELATED_TEST_SECRET = 'should-not-leak-either';
      mocks.spawnMock.mockReturnValueOnce(createChild());

      await runCodexCliQuery({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        schema: z.object({ ok: z.boolean() }),
        options: { bin: 'codex' },
      });

      expect(mocks.spawnMock).toHaveBeenCalledTimes(1);
      const [, , spawnOptions] = mocks.spawnMock.mock.calls[0];
      expect(spawnOptions.env.PATH).toBe(process.env.PATH);
      expect(spawnOptions.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(spawnOptions.env.UNRELATED_TEST_SECRET).toBeUndefined();
    });
  });
});
