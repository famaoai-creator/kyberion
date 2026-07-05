import { describe, expect, it } from 'vitest';
import {
  pathResolver,
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import { detectResourceRegressions, runSoakEnduranceHarness } from './soak_endurance.js';

describe('soak_endurance', () => {
  it('captures a time series with sampled file sizes', async () => {
    const sampleRoot = pathResolver.sharedTmp('soak-endurance-tests/series');
    safeRmSync(sampleRoot, { recursive: true, force: true });
    const samplePath = pathResolver.sharedTmp('soak-endurance-tests/series/history.jsonl');

    const report = await runSoakEnduranceHarness({
      cycles: 4,
      samplePaths: [samplePath],
      exercise: async (cycle) => {
        safeMkdir(pathResolver.sharedTmp('soak-endurance-tests/series'), { recursive: true });
        if (cycle === 1) {
          safeWriteFile(samplePath, `${'x'.repeat(cycle)}\n`);
        } else {
          safeAppendFileSync(samplePath, `${'x'.repeat(cycle)}\n`);
        }
      },
      reportPath: pathResolver.sharedTmp('soak-endurance-tests/report.json'),
      metricsDir: pathResolver.sharedTmp('soak-endurance-tests/metrics'),
      metricsFile: 'history.jsonl',
    });

    expect(report.cycles).toBe(4);
    expect(report.samples).toHaveLength(4);
    expect(report.samples[0].sampled_files[samplePath]).toBeGreaterThan(0);
    expect(report.maintenance_summary.tenant_drift_findings).toBeGreaterThanOrEqual(0);
    expect(safeExistsSync(pathResolver.sharedTmp('soak-endurance-tests/report.json'))).toBe(true);
  });

  it('detects monotonic growth in resource samples', () => {
    const samplePath = pathResolver.sharedTmp('soak-endurance-tests/growth.jsonl');
    const samples = [
      {
        cycle: 1,
        timestamp: '2026-07-05T00:00:00.000Z',
        duration_ms: 1,
        rss_mb: 10,
        heap_used_mb: 10,
        heap_total_mb: 20,
        open_handles: 1,
        sampled_files: { [samplePath]: 10 },
      },
      {
        cycle: 2,
        timestamp: '2026-07-05T00:00:01.000Z',
        duration_ms: 1,
        rss_mb: 11,
        heap_used_mb: 11,
        heap_total_mb: 20,
        open_handles: 1,
        sampled_files: { [samplePath]: 1024 },
      },
      {
        cycle: 3,
        timestamp: '2026-07-05T00:00:02.000Z',
        duration_ms: 1,
        rss_mb: 12,
        heap_used_mb: 12,
        heap_total_mb: 20,
        open_handles: 1,
        sampled_files: { [samplePath]: 2048 },
      },
      {
        cycle: 4,
        timestamp: '2026-07-05T00:00:03.000Z',
        duration_ms: 1,
        rss_mb: 13,
        heap_used_mb: 13,
        heap_total_mb: 20,
        open_handles: 1,
        sampled_files: { [samplePath]: 4096 },
      },
    ];

    const regressions = detectResourceRegressions(samples as any);
    expect(regressions.some((finding) => finding.resource === 'rss_mb')).toBe(true);
    expect(regressions.some((finding) => finding.resource === samplePath)).toBe(true);
  });

  it('writes latency history that can be inspected later', async () => {
    const historyDir = pathResolver.sharedTmp('soak-endurance-tests/latency');
    safeRmSync(historyDir, { recursive: true, force: true });

    await runSoakEnduranceHarness({
      cycles: 2,
      exercise: async (cycle) => {
        const historyPath = pathResolver.sharedTmp(
          `soak-endurance-tests/latency/cycle-${cycle}.jsonl`
        );
        safeMkdir(pathResolver.sharedTmp('soak-endurance-tests/latency'), { recursive: true });
        safeAppendFileSync(historyPath, JSON.stringify({ cycle }) + '\n');
      },
      metricsDir: historyDir,
      metricsFile: 'latency-history.jsonl',
      reportPath: pathResolver.sharedTmp('soak-endurance-tests/latency-report.json'),
    });

    const persisted = safeReadFile(
      pathResolver.sharedTmp('soak-endurance-tests/latency/latency-history.jsonl'),
      { encoding: 'utf8' }
    ) as string;
    expect(persisted).toContain('ao-04-soak-cycle');
  });

  it('rolls over the 30-day evidence log to the configured retention window', async () => {
    const report = await runSoakEnduranceHarness({
      cycles: 4,
      evidenceRetentionCount: 2,
      reportPath: pathResolver.sharedTmp('soak-endurance-tests/rollover-report.json'),
      metricsDir: pathResolver.sharedTmp('soak-endurance-tests/rollover-metrics'),
      metricsFile: 'history.jsonl',
      exercise: async () => {},
    });

    const evidenceLog = safeReadFile(report.evidence.run_log_path, { encoding: 'utf8' }) as string;
    expect(evidenceLog.trim().split('\n')).toHaveLength(2);
    expect(safeReadFile(report.evidence.summary_path, { encoding: 'utf8' })).toContain(
      '# 30-day soak run summary'
    );
  });
});
