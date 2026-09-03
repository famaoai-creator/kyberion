import { describe, expect, it } from 'vitest';
import { runReportReviewServer } from './server.js';

describe('report review server harness boundary', () => {
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
});
