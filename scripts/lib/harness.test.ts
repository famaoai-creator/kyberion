import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import {
  defineGenerator,
  defineScript,
  parseScriptFlags,
  ScriptExitError,
  stripSharedScriptFlags,
} from './harness.js';

const NORMALIZED_OUTPUT = pathResolver.sharedTmp('harness-test/generator-output.txt');

describe('script harness', () => {
  it('normalizes shared flags without consuming positional arguments', () => {
    expect(parseScriptFlags(['--json', '--dry-run', 'catalog.json', '--check'])).toEqual({
      json: true,
      dryRun: true,
      check: true,
      quiet: false,
      positional: ['catalog.json'],
      unknownFlags: [],
    });
  });

  it('honors a script-declared flag surface', () => {
    expect(parseScriptFlags(['--json', '--check'], ['check'])).toEqual({
      json: false,
      dryRun: false,
      check: true,
      quiet: false,
      positional: ['--json'],
      unknownFlags: ['--json'],
    });
  });

  it('strips shared flags before delegating to a legacy parser', () => {
    expect(stripSharedScriptFlags(['--json', 'command', '--', '--dry-run'])).toEqual(['command']);
  });

  it('uses the shared flag surface when a script omits flags', async () => {
    process.exitCode = undefined;
    delete process.env.LOG_LEVEL;
    const main = defineScript({
      name: 'harness-default-flags-test',
      run: (context) => context,
    });

    const result = await main(['--json', '--quiet', 'input.json']);

    expect(result).toMatchObject({
      json: true,
      quiet: true,
      positional: ['input.json'],
      unknownFlags: [],
    });
    expect(process.exitCode).toBeUndefined();
    expect(process.env.LOG_LEVEL).toBeUndefined();
  });

  it('suppresses dependency logs while a JSON report is being rendered', async () => {
    delete process.env.LOG_LEVEL;
    const main = defineScript({
      name: 'harness-json-quiet-test',
      run: (context) => {
        expect(context.json).toBe(true);
        expect(process.env.LOG_LEVEL).toBe('silent');
        return { status: 'ok' };
      },
    });

    const result = await main(['--json']);

    expect(result).toEqual({ status: 'ok' });
    expect(process.env.LOG_LEVEL).toBeUndefined();
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

  it('resolves generator outputs from the invocation context', async () => {
    const outputPath = pathResolver.sharedTmp('harness-test/dynamic-output.txt');
    const main = defineGenerator({
      id: 'harness-dynamic-output-test',
      outputs: (context) => [
        context.positional[0] === 'alternate' ? outputPath : NORMALIZED_OUTPUT,
      ],
      render: (context) => [
        {
          path: context.positional[0] === 'alternate' ? outputPath : NORMALIZED_OUTPUT,
          content: 'dynamic value',
        },
      ],
    });

    process.exitCode = undefined;
    const result = await main(['alternate', '--check']);

    expect(result?.changed).toEqual([outputPath]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it('uses the shared failure boundary for undeclared generator outputs', async () => {
    process.exitCode = undefined;
    const main = defineGenerator({
      id: 'harness-undeclared-output-test',
      outputs: [],
      render: () => [{ path: NORMALIZED_OUTPUT, content: 'unexpected value' }],
    });

    const result = await main([]);

    expect(result).toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it('rejects generator output paths that traverse a symbolic link', async () => {
    const targetPath = pathResolver.sharedTmp('harness-test/generator-target.txt');
    const linkedPath = pathResolver.sharedTmp('harness-test/generator-link.txt');
    safeWriteFile(targetPath, 'existing value');
    safeSymlinkSync(targetPath, linkedPath);
    try {
      process.exitCode = undefined;
      const main = defineGenerator({
        id: 'harness-symlink-output-test',
        outputs: [linkedPath],
        render: () => [{ path: linkedPath, content: 'new value' }],
      });

      const result = await main([]);

      expect(result).toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
      safeRmSync(linkedPath, { recursive: true, force: true });
      safeRmSync(targetPath, { recursive: true, force: true });
    }
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
