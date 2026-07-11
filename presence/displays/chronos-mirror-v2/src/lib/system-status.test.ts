import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeWriteFile } from '@agent/core/secure-io';

import {
  buildSystemStatusReport,
  collectProviderDemotions,
  summarizeTraceWindow,
} from './system-status';

const T0 = Date.parse('2026-07-11T12:00:00.000Z');

describe('collectProviderDemotions', () => {
  it('reads persisted demotions and drops expired or malformed entries', () => {
    const dir = pathResolver.sharedTmp(`system-status-tests/${Date.now()}`);
    safeMkdir(dir, { recursive: true });
    const statePath = path.join(dir, 'provider-health.json');
    safeWriteFile(
      statePath,
      JSON.stringify({
        demotions: [
          { provider: 'codex', instance: 'default', until: T0 + 60_000, reason: 'rate_limited' },
          { provider: 'gemini', instance: 'default', until: T0 - 1, reason: 'expired' },
          { provider: '', instance: 'x', until: T0 + 60_000, reason: 'malformed' },
        ],
      })
    );

    const demoted = collectProviderDemotions(T0, statePath);
    expect(demoted).toHaveLength(1);
    expect(demoted[0].provider).toBe('codex');
  });

  it('returns empty for missing or corrupt state files', () => {
    const dir = pathResolver.sharedTmp(`system-status-tests/${Date.now()}-corrupt`);
    safeMkdir(dir, { recursive: true });
    const statePath = path.join(dir, 'provider-health.json');
    expect(collectProviderDemotions(T0, statePath)).toEqual([]);
    safeWriteFile(statePath, '{broken');
    expect(collectProviderDemotions(T0, statePath)).toEqual([]);
  });
});

describe('summarizeTraceWindow', () => {
  it('counts only traces inside the one-hour window', () => {
    const summary = summarizeTraceWindow(
      [
        { startedAt: new Date(T0 - 10 * 60_000).toISOString(), status: 'ok' },
        { startedAt: new Date(T0 - 30 * 60_000).toISOString(), status: 'error' },
        { startedAt: new Date(T0 - 2 * 60 * 60_000).toISOString(), status: 'error' }, // too old
        { startedAt: 'not-a-date', status: 'error' },
      ],
      T0
    );
    expect(summary).toEqual({ total: 2, errors: 1, error_rate: 0.5 });
  });
});

describe('buildSystemStatusReport rollup', () => {
  const cleanTraces = { total: 10, errors: 0, error_rate: 0 };

  it('green when nothing is wrong', () => {
    const report = buildSystemStatusReport({ now: T0, demoted: [], traces: cleanTraces });
    expect(report.rollup).toBe('green');
    expect(report.reasons).toHaveLength(1);
  });

  it('yellow on demotions or scattered errors', () => {
    const demoted = [
      { provider: 'codex', instance: 'work', until: T0 + 1000, reason: 'rate_limited' },
    ];
    expect(buildSystemStatusReport({ now: T0, demoted, traces: cleanTraces }).rollup).toBe(
      'yellow'
    );
    expect(
      buildSystemStatusReport({
        now: T0,
        demoted: [],
        traces: { total: 10, errors: 1, error_rate: 0.1 },
      }).rollup
    ).toBe('yellow');
  });

  it('red when the error rate crosses the threshold with enough samples', () => {
    const report = buildSystemStatusReport({
      now: T0,
      demoted: [],
      traces: { total: 6, errors: 3, error_rate: 0.5 },
    });
    expect(report.rollup).toBe('red');
    expect(report.reasons.join(' ')).toContain('error rate');
  });

  it('stays yellow when the rate is high but the sample count is tiny', () => {
    const report = buildSystemStatusReport({
      now: T0,
      demoted: [],
      traces: { total: 2, errors: 2, error_rate: 1 },
    });
    expect(report.rollup).toBe('yellow');
  });
});
