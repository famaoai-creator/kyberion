import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core';
import { getSecret } from '@agent/core/secret/secret-guard';
import { clearProcessExitCode, defineScript, ScriptExitError } from '@agent/core/script-harness';
import { runReadCommand } from './cli-read.js';

/**
 * R05 characterization contract for the shared CLI error/JSON boundary:
 * success reports are one JSON document on stdout, failures are one JSON
 * document on stderr, and the machine fields (code/category/retryable/
 * next_action) are additive — never a breaking change to the old payload.
 */
describe('script-harness error contract', () => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  beforeEach(() => {
    stdout.length = 0;
    stderr.length = 0;
    vi.spyOn(console, 'log').mockImplementation((value: unknown) => {
      stdout.push(String(value));
    });
    vi.spyOn(console, 'error').mockImplementation((value: unknown) => {
      stderr.push(String(value));
    });
    clearProcessExitCode();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    clearProcessExitCode();
  });

  const stderrJson = () => {
    expect(stderr).toHaveLength(1);
    return JSON.parse(stderr[0]) as Record<string, unknown>;
  };

  it('pins the success JSON shape: one parseable document on stdout, empty stderr', async () => {
    const script = defineScript({
      name: 'contract-success',
      run: (context) => {
        context.print({ ok: true, value: 42 });
      },
    });
    await script(['--json']);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual({ ok: true, value: 42 });
    expect(stderr).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it('pins the stderr error shape for classified ScriptExitError (additive fields)', async () => {
    const script = defineScript({
      name: 'contract-classified',
      run: () => {
        throw new ScriptExitError(1, 'leaf missing inside the repository', false, undefined, {
          code: 'NOT_FOUND',
          category: 'not_found',
          retryable: false,
          next_action: 'verify the path exists, then retry',
        });
      },
    });
    await script(['--json']);
    expect(stdout).toEqual([]);
    expect(stderrJson()).toEqual({
      ok: false,
      error: 'leaf missing inside the repository',
      code: 'NOT_FOUND',
      category: 'not_found',
      retryable: false,
      next_action: 'verify the path exists, then retry',
    });
    expect(process.exitCode).toBe(1);
  });

  it('keeps the historical payload for unclassified ScriptExitError (no invented code)', async () => {
    const script = defineScript({
      name: 'contract-plain-exit',
      run: () => {
        throw new ScriptExitError(2, 'usage: do the thing');
      },
    });
    await script(['--json']);
    const report = stderrJson();
    expect(report).toEqual({ ok: false, error: 'usage: do the thing' });
    expect(report).not.toHaveProperty('code');
    expect(process.exitCode).toBe(2);
  });

  it('classifies uncategorized exceptions as internal_error and hides stacks by default', async () => {
    const script = defineScript({
      name: 'contract-internal',
      run: () => {
        throw new Error('totally unexpected failure');
      },
    });
    await script(['--json']);
    const report = stderrJson();
    expect(report).toMatchObject({
      ok: false,
      error: 'totally unexpected failure',
      code: 'INTERNAL_ERROR',
      category: 'internal_error',
    });
    expect(report).not.toHaveProperty('stack');
    expect(process.exitCode).toBe(1);
  });

  it('redacts active secrets from DEBUG stacks and error text', async () => {
    vi.stubEnv('CONTRACT_TEST_SECRET', 'contract-secret-token-value');
    getSecret('CONTRACT_TEST_SECRET');
    vi.stubEnv('DEBUG', '1');
    const script = defineScript({
      name: 'contract-redact',
      run: () => {
        throw new Error('failure while using contract-secret-token-value');
      },
    });
    await script(['--json']);
    const report = stderrJson();
    expect(report.error).not.toContain('contract-secret-token-value');
    expect(String(report.stack)).not.toContain('contract-secret-token-value');
    expect(JSON.stringify(report)).toContain('[REDACTED_SECRET]');
  });

  it('keeps errno remediation in next_action without leaking a stack', async () => {
    const missing = path.join('active', 'shared', 'tmp', `contract-${randomUUID()}`, 'gone.txt');
    const script = defineScript({
      name: 'contract-errno',
      run: () => {
        const error = new Error(`ENOENT: no such file or directory, open '${missing}'`);
        (error as NodeJS.ErrnoException).code = 'ENOENT';
        throw error;
      },
    });
    await script(['--json']);
    const report = stderrJson();
    expect(report).toMatchObject({
      ok: false,
      code: 'INTERNAL_ERROR',
      category: 'internal_error',
      next: 'verify the path exists, then retry',
      next_action: 'verify the path exists, then retry',
    });
  });
});

describe('read command error contract', () => {
  let workDir = '';

  const detailsOf = async (argv: string[]) => {
    try {
      await runReadCommand(argv, () => undefined);
      return undefined;
    } catch (error) {
      expect(error).toBeInstanceOf(ScriptExitError);
      return error as ScriptExitError;
    }
  };

  beforeEach(() => {
    workDir = pathResolver.sharedTmp(`cli-error-contract-${randomUUID()}`);
    safeMkdir(workDir, { recursive: true });
  });

  afterEach(() => {
    if (workDir) safeRmSync(workDir, { recursive: true, force: true });
  });

  it('answers NOT_FOUND only for a missing leaf inside the allowed repository scope', async () => {
    const missing = path.join(workDir, 'missing.pdf');
    const error = await detailsOf([missing]);
    expect(error?.details?.code).toBe('NOT_FOUND');
    expect(error?.details?.category).toBe('not_found');
    expect(error?.message).toContain('does not exist inside the repository');
  });

  it('answers OUTSIDE_ALLOWED_SCOPE for outside paths without revealing existence', async () => {
    // One path exists, one does not: the refusal must be identical so read
    // cannot be used as an existence oracle outside the allowed scope.
    const missing = await detailsOf(['/nonexistent/definitely-absent-file.pdf']);
    const existing = await detailsOf(['/etc/hosts']);
    for (const error of [missing, existing]) {
      expect(error?.details?.code).toBe('OUTSIDE_ALLOWED_SCOPE');
      expect(error?.details?.category).toBe('permission_denied');
      expect(error?.message).toContain('outside the repository');
    }
    // Normalized messages are identical: whether the path exists never leaks.
    expect(existing?.message.replaceAll('/etc/hosts', '<PATH>')).toBe(
      missing?.message.replaceAll('/nonexistent/definitely-absent-file.pdf', '<PATH>')
    );
  });

  it('classifies a URL as invalid input pointing at the governed fetch path', async () => {
    const error = await detailsOf(['https://example.com/a.pdf']);
    expect(error?.details?.code).toBe('INVALID_INPUT');
    expect(error?.details?.category).toBe('invalid_input');
    expect(error?.details?.next_action).toContain('network:fetch');
  });

  it('keeps stdout a single JSON document under --json --images/--out', async () => {
    const doc = path.join(workDir, 'note.md');
    safeWriteFile(doc, '# Title\n\nBody.');
    const imagesDir = path.join(workDir, 'images');
    const out = path.join(workDir, 'note.json');
    const output: string[] = [];
    await runReadCommand([doc, '--json', '--images', imagesDir], (text) => output.push(text));
    expect(output).toHaveLength(1);
    const withImages = JSON.parse(output[0]) as Record<string, unknown>;
    expect(withImages.format).toBe('markdown');
    expect(withImages.notices).toEqual(
      expect.arrayContaining([expect.stringContaining('[read] 0 image(s) written')])
    );

    output.length = 0;
    await runReadCommand([doc, '--json', '--out', out], (text) => output.push(text));
    expect(output).toHaveLength(1);
    const withOut = JSON.parse(output[0]) as Record<string, unknown>;
    expect(withOut.written_to).toBe(out);
    const written = JSON.parse(String(safeReadFile(out, { encoding: 'utf8' })));
    expect(written.format).toBe('markdown');
    expect(written).not.toHaveProperty('written_to');
  });

  it('does not print a result document when the command fails (no double JSON)', async () => {
    const output: string[] = [];
    await expect(
      runReadCommand([path.join(workDir, 'missing.pdf'), '--json'], (text) => output.push(text))
    ).rejects.toBeInstanceOf(ScriptExitError);
    expect(output).toEqual([]);
  });
});
