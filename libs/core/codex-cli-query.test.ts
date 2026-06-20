import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCodexCliQueryOptionsFromEnv } from './codex-cli-query.js';

const mocks = vi.hoisted(() => ({
  safeExecResult: vi.fn(),
}));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return {
    ...actual,
    safeExecResult: mocks.safeExecResult,
  };
});

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
});
