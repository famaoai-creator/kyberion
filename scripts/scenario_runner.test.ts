import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import {
  collectScenarioFiles,
  formatScenarioSummary,
  parseScenarioRunnerArgs,
  runScenarioFiles,
  runScenarioRunner,
} from './scenario_runner.js';

const TMP_DIR = `active/shared/tmp/scenario-runner-test-${process.pid}`;
const reportDirs: string[] = [];

function scenarioJson(id: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 'kyberion-scenario.v1',
    id,
    title: id,
    tier: 1,
    lane: 'pr-deterministic',
    executionProfile: 'simulated',
    modelFixtures: 'model-free',
    requires: {},
    seed: {},
    fixtures: { ops: { 'service:publish_report': { ctx_patch: { published: true } } } },
    turns: [{ kind: 'pipeline', steps: [{ op: 'service:publish_report', params: {} }] }],
    finalChecks: [{ type: 'opCalled', op: 'service:publish_report', times: 1 }],
    ...overrides,
  });
}

function writeScenario(name: string, content: string): string {
  const dir = pathResolver.rootResolve(TMP_DIR);
  safeMkdir(dir, { recursive: true });
  const file = `${dir}/${name}`;
  safeWriteFile(file, content);
  return file;
}

afterEach(() => {
  safeRmSync(pathResolver.rootResolve(TMP_DIR), { recursive: true, force: true });
  for (const dir of reportDirs.splice(0)) {
    safeRmSync(pathResolver.rootResolve(dir), { recursive: true, force: true });
  }
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('scenario runner CLI (ES-05)', () => {
  it('parses run arguments, flags, and env defaults', () => {
    expect(
      parseScenarioRunnerArgs(['run', 'eval/scenarios', '--lane', 'pr-deterministic'], {})
    ).toEqual({
      target: 'eval/scenarios',
      lane: 'pr-deterministic',
      keep: false,
      exportTrajectory: false,
    });
    expect(
      parseScenarioRunnerArgs(['run', 'x.json', '--keep', '--export-trajectory'], {
        KYBERION_SCENARIO_LANE: 'live-only',
      })
    ).toEqual({ target: 'x.json', lane: 'live-only', keep: true, exportTrajectory: true });
    expect(
      parseScenarioRunnerArgs(['run', 'x.json'], { KYBERION_SCENARIO_KEEP_ROOT: 'true' }).keep
    ).toBe(true);
    expect(() => parseScenarioRunnerArgs(['walk', 'x'], {})).toThrow('usage: pnpm scenario run');
    expect(() => parseScenarioRunnerArgs(['run'], {})).toThrow('needs a <file|dir> target');
    expect(() => parseScenarioRunnerArgs(['run', 'x', '--lane', 'nightly'], {})).toThrow(
      '--lane must be one of'
    );
    expect(() => parseScenarioRunnerArgs(['run', 'x', '--bogus'], {})).toThrow('unknown flag');
  });

  it('collects top-level scenario files only (fixtures excluded)', () => {
    const files = collectScenarioFiles('eval/scenarios').map((file) =>
      pathResolver.toRepoRelative(file)
    );
    expect(files).toHaveLength(5);
    expect(files.every((file) => !file.includes('/fixtures/'))).toBe(true);
  });

  it('writes report.json/md and trajectory.jsonl to the sibling results dir', async () => {
    const pass = writeScenario('a-pass.json', scenarioJson('runner-pass'));
    const live = writeScenario('b-live.json', scenarioJson('runner-live', { lane: 'live-only' }));
    const invalid = writeScenario('c-invalid.json', '{"schema_version": "kyberion-scenario.v1"}');
    const summary = await runScenarioFiles([pass, live, invalid], {
      lane: 'pr-deterministic',
      keep: false,
      exportTrajectory: true,
    });
    for (const entry of summary.scenarios) if (entry.report_dir) reportDirs.push(entry.report_dir);

    expect(summary.scenarios.map((entry) => entry.status)).toEqual([
      'pass',
      'lane_skipped',
      'error',
    ]);
    expect(summary.ok).toBe(false);
    expect(summary.counts).toMatchObject({ pass: 1, lane_skipped: 1, error: 1 });
    expect(summary.scenarios[2]?.reason).toContain('[SCENARIO_INVALID]');

    const dir = pathResolver.rootResolve(summary.scenarios[0]!.report_dir!);
    expect(dir).toContain('active/shared/tmp/scenario-reports/');
    const report = JSON.parse(String(safeReadFile(`${dir}/report.json`, { encoding: 'utf8' })));
    expect(report).toMatchObject({ scenario_id: 'runner-pass', status: 'pass' });
    expect(String(safeReadFile(`${dir}/report.md`, { encoding: 'utf8' }))).toContain(
      '# Scenario runner-pass: PASS'
    );
    const trajectory = JSON.parse(
      String(safeReadFile(`${dir}/trajectory.jsonl`, { encoding: 'utf8' })).trim()
    );
    expect(trajectory.schema_version).toBe('kyberion-scenario-trajectory.v1');
    // The run root itself is gone (no --keep).
    expect(safeExistsSync(pathResolver.sharedTmp(`scenarios/${report.run_id}`))).toBe(false);
    expect(formatScenarioSummary(summary)).toContain(
      '[scenario] 3 scenario(s): 1 pass, 0 fail, 0 skipped, 1 lane_skipped, 1 error'
    );
  });

  it('exits 1 when a scenario fails, 0 when only skips happen', async () => {
    const failing = writeScenario(
      'fail.json',
      scenarioJson('runner-fail', {
        turns: [{ kind: 'pipeline', steps: [{ op: 'system:exec', params: { command: 'true' } }] }],
        finalChecks: [],
      })
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const failed = await runScenarioRunner(['run', pathResolver.toRepoRelative(failing), '--json']);
    expect(process.exitCode).toBe(1);
    expect(failed).toMatchObject({ ok: false, counts: { fail: 1 } });
    const failedEntry = (failed as { scenarios: { report_dir?: string; reason?: string }[] })
      .scenarios[0]!;
    reportDirs.push(failedEntry.report_dir!);
    expect(failedEntry.reason).toContain('[SCENARIO_UNSTUBBED_OP] system:exec');

    process.exitCode = undefined;
    const live = writeScenario(
      'live.json',
      scenarioJson('runner-live-only', { lane: 'live-only' })
    );
    const skipped = await runScenarioRunner([
      'run',
      pathResolver.toRepoRelative(live),
      '--lane',
      'pr-deterministic',
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(skipped).toMatchObject({ ok: true, counts: { lane_skipped: 1 } });
    expect(log).toHaveBeenCalled();
  });
});
