import { describe, expect, it } from 'vitest';
import { formatPipelineDryRunReport, runPipelineDryRun } from './run_pipeline_dry_run.js';

describe('pipeline dry-run entrypoint', () => {
  it('keeps the human report format in a pure formatter', async () => {
    const report = await runPipelineDryRun('pipelines/does-not-exist.json');

    expect(report.verdict).toBe('blocked');
    expect(formatPipelineDryRunReport(report)).toEqual([
      expect.stringContaining('[pipeline-dry-run] blocked:'),
      expect.stringContaining('- blocked:'),
      expect.stringContaining('next:'),
    ]);
  });

  it('resolves the scheduled weekly review actuator operations', async () => {
    const report = await runPipelineDryRun('pipelines/weekly-review.json');

    expect(report.verdict).toBe('ready');
    expect(report.checks.filter((check) => check.id === 'capability-resolution')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'pass',
          message: "Operation 'working-memory:weekly-open' is registered.",
        }),
        expect.objectContaining({
          status: 'pass',
          message: "Operation 'working-memory:consolidation-status' is registered.",
        }),
        expect.objectContaining({
          status: 'pass',
          message: "Operation 'working-memory:nominate-promotion' is registered.",
        }),
      ])
    );
  });
});
