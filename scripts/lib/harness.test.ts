import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver, safeRmSync, safeWriteFile } from '@agent/core';
import { defineGenerator, defineScript, parseScriptFlags, ScriptExitError } from './harness.js';

const NORMALIZED_OUTPUT = pathResolver.sharedTmp('harness-test/generator-output.txt');

describe('script harness', () => {
  it('normalizes shared flags without consuming positional arguments', () => {
    expect(parseScriptFlags(['--json', '--dry-run', 'catalog.json', '--check'])).toEqual({
      json: true,
      dryRun: true,
      check: true,
      quiet: false,
      positional: ['catalog.json'],
    });
  });

  it('honors a script-declared flag surface', () => {
    expect(parseScriptFlags(['--json', '--check'], ['check'])).toEqual({
      json: false,
      dryRun: false,
      check: true,
      quiet: false,
      positional: ['--json'],
    });
  });

  afterEach(() => {
    safeRmSync(NORMALIZED_OUTPUT, { force: true });
  });

  it('supports generator-specific comparison normalization', async () => {
    safeWriteFile(NORMALIZED_OUTPUT, 'generated value');
    const main = defineGenerator({
      id: 'harness-test',
      outputs: [NORMALIZED_OUTPUT],
      normalize: (content) => content.replaceAll(' ', ''),
      render: () => [{ path: NORMALIZED_OUTPUT, content: 'generatedvalue' }],
    });

    process.exitCode = undefined;
    const result = await main(['--check']);

    expect(result?.changed).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it('preserves governed non-zero exit codes without forcing process termination', async () => {
    process.exitCode = undefined;
    const main = defineScript({
      name: 'harness-exit-test',
      run: () => {
        throw new ScriptExitError(2, 'approval required');
      },
    });

    await main([]);

    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
  });
});
