import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { main as runPipelineMain } from './pipeline-execution-part-results.js';
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

  it('keeps the dry-run CLI output and exit boundary in the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/pipeline-execution-part-results.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).not.toContain('process.stdout.write');
    expect(source).not.toContain('process.stderr.write');
    expect(source).not.toContain('process.exitCode');
    expect(source).toContain('print(report)');
    const launcherSource = String(
      safeReadFile(pathResolver.rootResolve('scripts/run_pipeline.ts'), { encoding: 'utf8' }) || ''
    );
    expect(launcherSource).toContain('runPipelineMain(resolvePipelinePresetArgs(argv), print)');
  });

  it('emits JSON dry-run results through the injected printer', async () => {
    const output: unknown[] = [];

    await runPipelineMain(
      ['--input', 'pipelines/weekly-review.json', '--dry-run', '--json'],
      (value) => output.push(value)
    );

    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ pipeline_id: 'weekly-review', verdict: 'ready' });
  });

  it('keeps blocked dry-run reports machine-readable while returning exit code 1', async () => {
    const output: unknown[] = [];

    await expect(
      runPipelineMain(
        ['--input', 'pipelines/does-not-exist.json', '--dry-run', '--json'],
        (value) => output.push(value)
      )
    ).rejects.toMatchObject({ code: 1, silent: true });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ verdict: 'blocked', side_effects: 'none' });
  });
});
