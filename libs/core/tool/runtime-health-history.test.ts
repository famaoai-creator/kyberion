import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateDegradation } from '../daemon/health-degradation.js';
import {
  evaluateRuntimeHealthTrends,
  loadRuntimeHealthSamples,
  recordRuntimeHealthSample,
  RUNTIME_HEALTH_RETENTION_MS,
  setRuntimeHealthStoreTuningForTests,
  type RuntimeHealthSample,
} from './runtime-health-history.js';
import {
  resetAppendOnlyStoreMaintenanceState,
  setAppendOnlyStoreTestHooks,
} from '../storage/append-only-store.js';
import {
  safeAppendFileSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
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

/** A leaking sample: the post-GC heap grows with RSS. */
function leak(rss_mb: number): RuntimeHealthSample {
  return sample({ rss_mb, heap_used_mb: rss_mb * 0.6 });
}

describe('runtime health trends (OP-04)', () => {
  it('needs the heap floor to rise too: RSS growth with a flat heap is not reported', () => {
    expect(
      evaluateRuntimeHealthTrends([sample({ rss_mb: 100 }), sample({ rss_mb: 300 })], THRESHOLDS)
    ).toEqual([]);
  });

  it('flags RSS growth beyond the warning and red ratios', () => {
    const warning = evaluateRuntimeHealthTrends([leak(200), leak(320)], THRESHOLDS);
    expect(warning).toEqual([expect.objectContaining({ kind: 'rss_growth', severity: 'warning' })]);

    const critical = evaluateRuntimeHealthTrends([leak(100), leak(300)], THRESHOLDS);
    expect(critical[0].severity).toBe('critical');
  });

  it('stays quiet for stable memory and single samples', () => {
    expect(
      evaluateRuntimeHealthTrends([sample({ rss_mb: 100 }), sample({ rss_mb: 120 })], THRESHOLDS)
    ).toEqual([]);
    expect(evaluateRuntimeHealthTrends([sample({ rss_mb: 100 })], THRESHOLDS)).toEqual([]);
  });

  it('ignores a post-sleep dip and GC saw-tooth around a flat level', () => {
    const rss = [29.4, 260, 27.9, 240, 280, 230, 270, 250, 290, 245, 260, 255];
    const samples = rss.map((rss_mb) => sample({ rss_mb }));
    expect(evaluateRuntimeHealthTrends(samples, THRESHOLDS)).toEqual([]);
  });

  it('still flags sustained growth across the window', () => {
    const samples = [100, 110, 105, 120, 180, 220, 260, 300, 320].map(leak);
    expect(evaluateRuntimeHealthTrends(samples, THRESHOLDS)).toEqual([
      expect.objectContaining({ kind: 'rss_growth', severity: 'critical' }),
    ]);
  });

  it('ignores spikes and a GC saw-tooth whose floor stays flat (chronos 2026-11-20)', () => {
    // [rss_mb, heap_used_mb] hourly: heavy in-process jobs spike RSS up to 1GB,
    // heap returns to ~100MB after each GC — no leak.
    const rows: Array<[number, number]> = [
      [277.8, 142],
      [197.5, 89.2],
      [258, 296.1],
      [250.8, 280.7],
      [383.6, 298.9],
      [258.9, 325.7],
      [370.8, 157.3],
      [255.2, 148.2],
      [1004.3, 146.2],
      [316.7, 95],
      [270.8, 277.7],
      [319.8, 192.4],
      [482.5, 364.8],
      [308.9, 111.3],
      [300.2, 287.3],
      [132, 108.5],
      [505.3, 142.2],
    ];
    const samples = rows.map(([rss_mb, heap_used_mb]) => sample({ rss_mb, heap_used_mb }));
    expect(evaluateRuntimeHealthTrends(samples, THRESHOLDS)).toEqual([]);
  });

  it('flags a JS heap leak whose post-GC floor keeps rising', () => {
    const rows: Array<[number, number]> = [
      [150, 60],
      [190, 90],
      [160, 65],
      [200, 95],
      [170, 70],
      [210, 100],
      [260, 140],
      [300, 180],
      [270, 150],
      [320, 200],
      [290, 170],
      [340, 220],
      [360, 230],
      [420, 280],
      [380, 250],
      [440, 300],
      [400, 260],
      [460, 320],
    ];
    const samples = rows.map(([rss_mb, heap_used_mb]) => sample({ rss_mb, heap_used_mb }));
    expect(evaluateRuntimeHealthTrends(samples, THRESHOLDS)).toEqual([
      expect.objectContaining({ kind: 'rss_growth', severity: 'warning' }),
    ]);
  });

  it('ignores small absolute growth even at a high ratio', () => {
    expect(
      evaluateRuntimeHealthTrends([sample({ rss_mb: 14 }), sample({ rss_mb: 29 })], THRESHOLDS)
    ).toEqual([]);
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
      runtimeSamples: [leak(200), leak(360)],
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

  it('reads the window from parked copies while a rewrite has the file moved aside', () => {
    const dir = pathResolver.sharedTmp(`runtime-health-parked-${process.pid}-${Date.now()}`);
    const file = path.join(dir, 'runtime-health.jsonl');
    setRuntimeHealthStoreTuningForTests({ historyPath: file, windowMinBytes: 1024 });
    resetAppendOnlyStoreMaintenanceState();
    try {
      const end = Date.parse('2026-10-01T00:00:00.000Z');
      const hour = 60 * 60 * 1000;
      const rows: string[] = [];
      for (let t = end - 60 * 24 * hour; t < end; t += 6 * hour) {
        rows.push(JSON.stringify(sample({ timestamp: new Date(t).toISOString() })));
      }
      safeMkdir(dir, { recursive: true });
      safeWriteFile(file, `${rows.join('\n')}\n`);
      const before = loadRuntimeHealthSamples(24 * hour, end);
      expect(before).toHaveLength(4);
      const late = sample({ timestamp: new Date(end + 1000).toISOString(), rss_mb: 120 });
      let parkedMissing: RuntimeHealthSample[] | undefined;
      let parkedRecreated: RuntimeHealthSample[] | undefined;
      setAppendOnlyStoreTestHooks({
        beforeWriteSurvivors: () => {
          if (parkedMissing) return; // the merge round re-runs the hook
          parkedMissing = loadRuntimeHealthSamples(24 * hour + 2000, end + 2000);
          // An append without the store lock recreates the live file.
          safeAppendFileSync(file, `${JSON.stringify(late)}\n`);
          parkedRecreated = loadRuntimeHealthSamples(24 * hour + 2000, end + 2000);
        },
      });
      recordRuntimeHealthSample({ processName: 'supervisor', now: end });
      expect(parkedMissing?.slice(0, 4)).toEqual(before);
      expect(parkedMissing).toHaveLength(5); // + the sample that triggered the rewrite
      expect(parkedRecreated?.slice(0, 5)).toEqual(parkedMissing);
      expect(parkedRecreated?.[5]).toEqual(late);
      // Published: no parked copies left, the late sample merged in once.
      expect(loadRuntimeHealthSamples(24 * hour + 2000, end + 2000)).toEqual(parkedRecreated);
    } finally {
      setAppendOnlyStoreTestHooks({});
      setRuntimeHealthStoreTuningForTests({});
      resetAppendOnlyStoreMaintenanceState();
      safeRmSync(dir, { recursive: true, force: true });
    }
  });
});
