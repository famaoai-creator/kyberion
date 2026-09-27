import { afterEach, describe, expect, it } from 'vitest';
import {
  getManagedProviderCliDefinition,
  listManagedProviderCliDefinitions,
  resolveManagedProviderCliEnvPath,
  resolveProviderCliCommand,
} from './provider-managed-env.js';

describe('provider managed env', () => {
  const previous = process.env.KYBERION_CODEX_CLI_BIN;

  afterEach(() => {
    if (previous === undefined) delete process.env.KYBERION_CODEX_CLI_BIN;
    else process.env.KYBERION_CODEX_CLI_BIN = previous;
  });

  it('registers the supported provider CLI set and npm install metadata', () => {
    expect(listManagedProviderCliDefinitions().map((entry) => entry.provider)).toEqual([
      'codex',
      'claude',
      'gemini',
      'agy',
      'grok',
      'cursor',
      'opencode',
      'devin',
    ]);
    expect(getManagedProviderCliDefinition('codex')).toMatchObject({
      binary: 'codex',
      npm_package: '@openai/codex',
    });
    expect(getManagedProviderCliDefinition('cursor')).not.toHaveProperty('npm_package');
  });

  it('keeps provider managed environments inside the governed runtime root', () => {
    expect(resolveManagedProviderCliEnvPath('codex')).toMatch(
      /active\/shared\/runtime\/tool-runtimes\/provider-cli\/codex$/
    );
  });

  it('honors an explicit provider binary override', () => {
    process.env.KYBERION_CODEX_CLI_BIN = '/operator/pinned/codex';
    expect(resolveProviderCliCommand('codex')).toBe('/operator/pinned/codex');
  });
});
