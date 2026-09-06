import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { main, readReportReviewTextFile, runReportReviewServer } from './server.js';

describe('report review server harness boundary', () => {
  it('rejects a directory replacement before report parsing', () => {
    expect(() => readReportReviewTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

  it('validates a target without binding in dry-run mode', async () => {
    const result = await runReportReviewServer([
      'presence/displays/presence-studio/static/onboarding.html',
      '--dry-run',
      '--quiet',
    ]);

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      port: 8137,
      listening: false,
    });
  });

  it('rejects ports outside the TCP port range', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await runReportReviewServer([
        'presence/displays/presence-studio/static/onboarding.html',
        '65536',
        '--check',
        '--quiet',
      ]);

      expect(result).toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('routes dry-run output through the injected printer', async () => {
    const output: unknown[] = [];
    const result = await main(['presence/displays/presence-studio/static/onboarding.html'], {
      dryRun: true,
      print: (value) => output.push(value),
    });

    expect(result).toMatchObject({ ok: true, mode: 'dry-run', listening: false });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ ok: true, mode: 'dry-run' });
  });

  it('keeps runtime output and exit handling behind the harness boundary', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/report-review/server.ts'));

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.exitCode');
    expect(source).toContain('getRegisteredEnvText, nowIso, readTextFile');
  });
});
