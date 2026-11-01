import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateDegradation } from '../health-degradation.js';
import {
  evaluateRuntimeHealthTrends,
  loadRuntimeHealthSamples,
  recordRuntimeHealthSample,
  RUNTIME_HEALTH_RETENTION_MS,
  setRuntimeHealthStoreTuningForTests,
  type RuntimeHealthSample,
} from './runtime-health-history.js';
import { resetAppendOnlyStoreMaintenanceState } from '../append-only-store.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';

const THRESHOLDS = {
  rss_growth_warning_ratio: 1.5,
  rss_growth_red_ratio: 2.5,
  restart_warning_count: 3,
  restart_red_count: 10,
};

function sample(overrides: Partial<RuntimeHealthSample>): RuntimeHealthSample {
  return {
    timestamp: '2026-07-12T00:00:00.000Z',
    process_name: 'supervisor',
    rss_mb: 100,
    heap_used_mb: 50,
    ...overrides,
  };
}

describe('runtime health trends (OP-04)', () => {
  it('flags RSS growth beyond the warning and red ratios', () => {
    const warning = evaluateRuntimeHealthTrends(
      [sample({ rss_mb: 100 }), sample({ rss_mb: 160 })],
      THRESHOLDS
    );
    expect(warning).toEqual([expect.objectContaining({ kind: 'rss_growth', severity: 'warning' })]);

    const critical = evaluateRuntimeHealthTrends(
      [sample({ rss_mb: 100 }), sample({ rss_mb: 300 })],
      THRESHOLDS
    );
    expect(critical[0].severity).toBe('critical');
  });

  it('stays quiet for stable memory and single samples', () => {
    expect(
      evaluateRuntimeHealthTrends([sample({ rss_mb: 100 }), sample({ rss_mb: 120 })], THRESHOLDS)
    ).toEqual([]);
    expect(evaluateRuntimeHealthTrends([sample({ rss_mb: 100 })], THRESHOLDS)).toEqual([]);
  });

  it('flags restart storms from cumulative per-agent counts', () => {
    const findings = evaluateRuntimeHealthTrends(
      [
        sample({ restarts: { 'agent-a': 1, 'agent-b': 0 } }),
        sample({ restarts: { 'agent-a': 3, 'agent-b': 2 } }),
      ],
      THRESHOLDS
    );
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'restart_frequency', severity: 'warning' }),
    ]);
    expect(findings[0].detail).toContain('4 agent restart(s)');
  });

  it('feeds the degradation verdict (yellow on trend warnings)', () => {
    const report = evaluateDegradation({
      regressions: [],
      demotedProviders: [],
      runtimeSamples: [sample({ rss_mb: 100 }), sample({ rss_mb: 180 })],
    });
    expect(report.verdict).toBe('yellow');
    expect(report.findings[0].kind).toBe('rss_growth');
  });

  it('skips schema-invalid persisted samples before trend evaluation', () => {
    const file = pathResolver.rootResolve('active/shared/runtime/health/runtime-health.jsonl');
    const hadFile = fs.existsSync(file);
    const original = hadFile ? fs.readFileSync(file) : undefined;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        timestamp: '2026-07-12T00:00:00.000Z',
        process_name: 'invalid',
        rss_mb: -1,
        heap_used_mb: 10,
      })}\n` +
        `${JSON.stringify(sample({ process_name: 'valid', timestamp: '2026-07-12T00:01:00.000Z' }))}\n`
    );

    try {
      expect(
        loadRuntimeHealthSamples(60 * 60 * 1000, Date.parse('2026-07-12T01:00:00.000Z'))
      ).toEqual([sample({ process_name: 'valid', timestamp: '2026-07-12T00:01:00.000Z' })]);
    } finally {
      if (original !== undefined) fs.writeFileSync(file, original);
      else fs.rmSync(file, { force: true });
    }
  });

  it('rejects a runtime health history directory', () => {
    const file = pathResolver.rootResolve('active/shared/runtime/health/runtime-health.jsonl');
    const hadFile = fs.existsSync(file);
    const original = hadFile && fs.statSync(file).isFile() ? fs.readFileSync(file) : undefined;
    fs.rmSync(file, { recursive: true, force: true });
    fs.mkdirSync(file, { recursive: true });

    try {
      expect(() => loadRuntimeHealthSamples(60_000)).toThrow(/must be a regular file/);
    } finally {
      fs.rmSync(file, { recursive: true, force: true });
      if (original !== undefined) fs.writeFileSync(file, original);
    }
  });

  it('windows the history at write time and reads the window backward', () => {
    const dir = pathResolver.sharedTmp(`runtime-health-window-${process.pid}-${Date.now()}`);
    const file = path.join(dir, 'runtime-health.jsonl');
    setRuntimeHealthStoreTuningForTests({ historyPath: file, windowMinBytes: 1024 });
    resetAppendOnlyStoreMaintenanceState();
    try {
      const end = Date.parse('2026-10-01T00:00:00.000Z');
      const hour = 60 * 60 * 1000;
      const rows: string[] = [];
      // 60 days of samples, one every 6 hours.
      for (let t = end - 60 * 24 * hour; t < end; t += 6 * hour) {
        rows.push(JSON.stringify(sample({ timestamp: new Date(t).toISOString() })));
      }
      safeMkdir(dir, { recursive: true });
      // A torn tail (a writer died mid-append) must not break either path.
      safeWriteFile(file, `${rows.join('\n')}\n{"timestamp":"2026-10-0`);
      const before = loadRuntimeHealthSamples(24 * hour, end);
      expect(before).toHaveLength(4);

      recordRuntimeHealthSample({ processName: 'supervisor', now: end });
      const kept = String(safeReadFile(file, { encoding: 'utf8' }))
        .split('\n')
        .filter((line) => line.trim());
      const oldest = Math.min(
        ...kept.flatMap((line) => {
          try {
            return [Date.parse((JSON.parse(line) as RuntimeHealthSample).timestamp)];
          } catch {
            return [];
          }
        })
      );
      expect(oldest).toBeGreaterThanOrEqual(end - RUNTIME_HEALTH_RETENTION_MS);
      expect(kept.length).toBeLessThan(rows.length);
      const after = loadRuntimeHealthSamples(24 * hour, end);
      expect(after.slice(0, 4)).toEqual(before);
      expect(after).toHaveLength(5);
    } finally {
      setRuntimeHealthStoreTuningForTests({});
      resetAppendOnlyStoreMaintenanceState();
      safeRmSync(dir, { recursive: true, force: true });
    }
  });
});
