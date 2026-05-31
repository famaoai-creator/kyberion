import { describe, expect, it } from 'vitest';
import { buildCodexCliQueryOptionsFromEnv } from './codex-cli-query.js';

describe('codex-cli-query', () => {
  it('prefers a real codex executable over the repo-local shim', () => {
    const options = buildCodexCliQueryOptionsFromEnv({
      PATH: [
        '/usr/bin',
        '/bin',
        '/Users/famao/kyberion/node_modules/.bin',
        '/opt/homebrew/bin',
      ].join(':'),
    } as NodeJS.ProcessEnv);

    expect(options.bin).toBe('/opt/homebrew/bin/codex');
  });

  it('keeps an explicit override when provided', () => {
    const options = buildCodexCliQueryOptionsFromEnv({
      PATH: '/usr/bin:/bin:/Users/famao/kyberion/node_modules/.bin:/opt/homebrew/bin',
      KYBERION_CODEX_CLI_BIN: '/custom/bin/codex',
    } as NodeJS.ProcessEnv);

    expect(options.bin).toBe('/custom/bin/codex');
  });
});
