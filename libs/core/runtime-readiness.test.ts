import { describe, expect, it } from 'vitest';
import {
  BUILTIN_READINESS_CHECKS,
  evaluateRuntimeReadiness,
  listReadinessChecks,
  registerReadinessCheck,
  toPublicReadinessReport,
} from './runtime-readiness.js';

const fixedNow = () => new Date('2026-11-04T00:00:00.000Z');

describe('runtime-readiness seam', () => {
  it('registers the builtin checks', () => {
    const ids = listReadinessChecks().map((check) => check.id);
    for (const check of BUILTIN_READINESS_CHECKS) expect(ids).toContain(check.id);
  });

  it('is ready only when every check passes', async () => {
    const ok = await evaluateRuntimeReadiness({
      checks: [
        { id: 'a', run: () => ({ ok: true }) },
        { id: 'b', run: async () => ({ ok: true }) },
      ],
      now: fixedNow,
    });
    expect(ok).toEqual({
      ready: true,
      checked_at: '2026-11-04T00:00:00.000Z',
      checks: [
        { id: 'a', ok: true },
        { id: 'b', ok: true },
      ],
    });

    const failing = await evaluateRuntimeReadiness({
      checks: [
        { id: 'a', run: () => ({ ok: true }) },
        { id: 'b', run: () => ({ ok: false, detail: 'store down' }) },
      ],
    });
    expect(failing.ready).toBe(false);
    expect(failing.checks[1]).toEqual({ id: 'b', ok: false, detail: 'store down' });
  });

  it('treats throwing and slow checks as not ready', async () => {
    const report = await evaluateRuntimeReadiness({
      timeoutMs: 20,
      checks: [
        {
          id: 'throws',
          run: () => {
            throw new Error('boom');
          },
        },
        { id: 'hangs', run: () => new Promise(() => undefined) },
      ],
    });
    expect(report.ready).toBe(false);
    expect(report.checks).toEqual([
      { id: 'throws', ok: false, detail: 'boom' },
      { id: 'hangs', ok: false, detail: 'timed out after 20ms' },
    ]);
  });

  it('is not ready when nothing vouches for the runtime', async () => {
    expect((await evaluateRuntimeReadiness({ checks: [] })).ready).toBe(false);
  });

  it('public projection carries ids and booleans only', async () => {
    const report = await evaluateRuntimeReadiness({
      checks: [{ id: 'x', run: () => ({ ok: false, detail: '/secret/path leaked?' }) }],
    });
    expect(toPublicReadinessReport(report)).toEqual({ ready: false, checks: { x: false } });
    expect(JSON.stringify(toPublicReadinessReport(report))).not.toContain('secret');
  });

  it('lets subsystems register their own dependency checks', async () => {
    const unregister = registerReadinessCheck({ id: 'test-extra', run: () => ({ ok: true }) });
    try {
      expect(listReadinessChecks().map((c) => c.id)).toContain('test-extra');
    } finally {
      unregister();
    }
  });

  it('builtin seam-policy and vcs-backend checks pass in a governed checkout', async () => {
    const report = await evaluateRuntimeReadiness({
      checks: BUILTIN_READINESS_CHECKS.filter((c) => c.id !== 'runtime-storage'),
    });
    expect(report.checks.map((c) => [c.id, c.ok])).toEqual([
      ['seam-policy', true],
      ['vcs-backend', true],
    ]);
  });
});
