/**
 * ES-05: `pnpm scenario run <file|dir> [--lane pr-deterministic|live-only] [--keep] [--json]
 * [--export-trajectory]`.
 *
 * Runs `kyberion-scenario.v1` files through `runScenario` with the pipeline
 * engine in-process, and writes `report.{json,md}` (plus `trajectory.jsonl`
 * when asked) to `active/shared/tmp/scenario-reports/<run-id>/` — a sibling of
 * the run root, which is removed after each run unless `--keep` is set. Exit
 * code 1 when any scenario fails or errors; skipped / lane_skipped don't fail.
 */

import * as path from 'node:path';
import { appendJsonLine, getRegisteredEnvText, getRegisteredEnv } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  ensureDir,
  safeExistsSync,
  safeLstat,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { loadScenarioFile, type ScenarioLane } from '@agent/core/scenario-definition';
import { runScenario, type ScenarioPipelineRunner } from '@agent/core/scenario-executor';
import {
  isFailingScenarioStatus,
  renderScenarioReportMarkdown,
  type ScenarioReport,
  type ScenarioRunStatus,
} from '@agent/core/scenario-report';
import type { TrajectoryRecord } from '@agent/core/scenario-trajectory';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { readValidatedWorkflowAdf } from './refactor/adf-input.js';
import { runValidatedSteps } from './run_pipeline.js';

const LANES: readonly ScenarioLane[] = ['pr-deterministic', 'live-only'];

export interface ScenarioRunnerArgs {
  target: string;
  lane?: ScenarioLane;
  keep: boolean;
  exportTrajectory: boolean;
}

export interface ScenarioRunSummaryEntry {
  file: string;
  scenario_id: string | null;
  run_id: string | null;
  status: ScenarioRunStatus;
  reason?: string;
  report_dir?: string;
  /** Repo-relative run root, present only when it was kept (`--keep`). */
  run_root?: string;
}

export interface ScenarioRunSummary {
  ok: boolean;
  counts: Record<ScenarioRunStatus, number>;
  scenarios: ScenarioRunSummaryEntry[];
}

/** In-process pipeline runner (same engine as `pnpm pipeline`, no subprocess). */
export function createInProcessPipelineRunner(): ScenarioPipelineRunner {
  return async ({ steps, pipelinePath, context, trace }) => {
    let resolvedSteps = steps ?? [];
    let baseContext: Record<string, unknown> = {};
    if (pipelinePath) {
      const pipeline = await readValidatedWorkflowAdf<{
        steps?: Record<string, unknown>[];
        context?: Record<string, unknown>;
      }>(pipelinePath);
      resolvedSteps = pipeline.steps ?? [];
      baseContext = pipeline.context ?? {};
    }
    const normalized = resolvedSteps.map((step) => ({ ...step, params: step.params ?? {} }));
    return runValidatedSteps(
      normalized as Parameters<typeof runValidatedSteps>[0],
      { ...baseContext, ...context },
      { quiet: true, hasHuman: false, trace }
    );
  };
}

export function parseScenarioRunnerArgs(
  positional: readonly string[],
  env: Record<string, string | undefined> = process.env
): ScenarioRunnerArgs {
  const args = [...positional];
  if (args[0] !== 'run') {
    throw new ScriptExitError(
      2,
      'usage: pnpm scenario run <file|dir> [--lane pr-deterministic|live-only] [--keep] [--json] [--export-trajectory]'
    );
  }
  args.shift();
  let target: string | undefined;
  let lane = getRegisteredEnvText('KYBERION_SCENARIO_LANE', { env }) as ScenarioLane | undefined;
  let keep = getRegisteredEnv('KYBERION_SCENARIO_KEEP_ROOT', { env }) === true;
  let exportTrajectory = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--lane') {
      lane = args[++index] as ScenarioLane | undefined;
    } else if (arg.startsWith('--lane=')) {
      lane = arg.slice('--lane='.length) as ScenarioLane;
    } else if (arg === '--keep') {
      keep = true;
    } else if (arg === '--export-trajectory') {
      exportTrajectory = true;
    } else if (arg.startsWith('-')) {
      throw new ScriptExitError(2, `unknown flag: ${arg}`);
    } else if (target === undefined) {
      target = arg;
    } else {
      throw new ScriptExitError(2, `unexpected argument: ${arg}`);
    }
  }
  if (!target) throw new ScriptExitError(2, 'scenario run needs a <file|dir> target');
  if (lane !== undefined && !LANES.includes(lane)) {
    throw new ScriptExitError(2, `--lane must be one of ${LANES.join(', ')}`);
  }
  return { target, ...(lane ? { lane } : {}), keep, exportTrajectory };
}

/** A file, or the top-level `*.json` files of a directory (fixtures/ subdirectories excluded). */
export function collectScenarioFiles(target: string): string[] {
  const absolute = pathResolver.rootResolve(target);
  if (!safeExistsSync(absolute))
    throw new ScriptExitError(2, `scenario target not found: ${target}`);
  if (safeLstat(absolute).isFile()) return [absolute];
  return safeReaddir(absolute)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => path.join(absolute, entry))
    .filter((file) => safeLstat(file).isFile());
}

function emptyCounts(): Record<ScenarioRunStatus, number> {
  return { pass: 0, fail: 0, skipped: 0, lane_skipped: 0, error: 0 };
}

function writeReportFiles(
  report: ScenarioReport,
  trajectory: TrajectoryRecord | undefined
): string {
  const dir = pathResolver.sharedTmp(`scenario-reports/${report.run_id}`);
  ensureDir(dir);
  safeWriteFile(path.join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  safeWriteFile(path.join(dir, 'report.md'), renderScenarioReportMarkdown(report));
  const trajectoryPath = path.join(dir, 'trajectory.jsonl');
  if (safeExistsSync(trajectoryPath)) safeRmSync(trajectoryPath);
  if (trajectory) appendJsonLine(trajectoryPath, trajectory);
  return pathResolver.toRepoRelative(dir);
}

export async function runScenarioFiles(
  files: readonly string[],
  args: Omit<ScenarioRunnerArgs, 'target'>,
  runPipeline: ScenarioPipelineRunner = createInProcessPipelineRunner()
): Promise<ScenarioRunSummary> {
  const counts = emptyCounts();
  const scenarios: ScenarioRunSummaryEntry[] = [];
  for (const file of files) {
    const relative = pathResolver.toRepoRelative(file);
    let entry: ScenarioRunSummaryEntry;
    try {
      const def = loadScenarioFile(file);
      let trajectory: TrajectoryRecord | undefined;
      let runRoot: string | undefined;
      const report = await runScenario(def, {
        ...(args.lane ? { lane: args.lane } : {}),
        keep: args.keep,
        onRunRoot: (value) => {
          runRoot = value;
        },
        exportTrajectory: args.exportTrajectory,
        onTrajectory: (value) => {
          trajectory = value;
        },
        baseDir: path.dirname(file),
        runPipeline,
      });
      entry = {
        file: relative,
        scenario_id: report.scenario_id,
        run_id: report.run_id,
        status: report.status,
        ...(report.reason ? { reason: report.reason } : {}),
        report_dir: writeReportFiles(report, trajectory),
        ...(args.keep && runRoot ? { run_root: pathResolver.toRepoRelative(runRoot) } : {}),
      };
      const failures = [
        ...report.turns.flatMap((turn) => [
          ...(turn.error ? [`turn ${turn.index}: ${turn.error}`] : []),
          ...turn.checks
            .filter((c) => !c.pass)
            .map((c) => `turn ${turn.index} ${c.type}: ${c.detail}`),
        ]),
        ...report.final_checks.filter((c) => !c.pass).map((c) => `${c.type}: ${c.detail}`),
      ];
      if (!entry.reason && failures.length > 0) entry.reason = failures.join('; ');
    } catch (error) {
      entry = {
        file: relative,
        scenario_id: null,
        run_id: null,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    counts[entry.status] += 1;
    scenarios.push(entry);
  }
  return {
    ok: !scenarios.some((entry) => isFailingScenarioStatus(entry.status)),
    counts,
    scenarios,
  };
}

export function formatScenarioSummary(summary: ScenarioRunSummary): string {
  const lines = summary.scenarios.map((entry) => {
    const label = entry.status.toUpperCase().padEnd(12);
    const suffix = entry.reason ? ` — ${entry.reason}` : '';
    return `${label} ${entry.scenario_id ?? entry.file}${suffix}`;
  });
  const counts = Object.entries(summary.counts)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
  lines.push(`[scenario] ${summary.scenarios.length} scenario(s): ${counts}`);
  const dirs = summary.scenarios.flatMap((entry) => (entry.report_dir ? [entry.report_dir] : []));
  if (dirs.length > 0) lines.push(`[scenario] reports: ${path.dirname(dirs[0]!)}/<run-id>/`);
  return lines.join('\n');
}

export const runScenarioRunner = defineScript({
  name: 'scenario',
  flags: ['json'],
  async run(context) {
    const args = parseScenarioRunnerArgs(context.positional);
    const summary = await runScenarioFiles(collectScenarioFiles(args.target), args);
    context.print(context.json ? summary : formatScenarioSummary(summary));
    if (!summary.ok) throw new ScriptExitError(1, '', true, summary);
    return summary;
  },
});

if (
  isDirectScript(import.meta.url, 'scenario_runner.ts') ||
  isDirectScript(import.meta.url, 'scenario_runner.js')
)
  void runScenarioRunner();
