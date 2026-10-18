/**
 * Eval-scenario seam (harness2 import): the bridge between Kyberion's eval
 * fixtures and the harnessing probe loop.
 *
 * The repo's eval/scenarios/*.json files are kyberion-scenario.v1 definitions
 * — stub/approval fixture scenarios executed in-process by `pnpm scenario`.
 * They are NOT directly probe targets: a probe needs a workspace dir plus a
 * shell command. A ProbeScenarioSpec wraps an eval target as that pair:
 *
 *   {
 *     "name": "stubbed-apply",
 *     "workspace_dir": "active/shared/tmp/scenario-ws/stubbed-apply",
 *     "command": ["pnpm", "scenario", "run", "eval/scenarios/01-pipeline-stubbed-apply.json"],
 *     "expect_outputs": ["out/report.json"]
 *   }
 *
 * An eval fixture pipeline is wrapped the same way — point `command` at
 * `pnpm pipeline --input <fixture-pipeline.json>` with the fixture's inputs
 * pre-staged inside `workspace_dir`; the probe then copies the workspace per
 * candidate and overlays the candidate's files before running the command.
 */

import { assertSafeRepositoryPath, loadJson, safeExistsSync, safeLstat } from '../secure-io.js';
import { isValidRelPath } from './surface-spec.js';

export interface ProbeScenarioSpec {
  /** Scenario name — used for labels and reports, never for paths. */
  name: string;
  /** In-repo directory staged per probe (the base workspace). */
  workspace_dir: string;
  /** Scenario command: argv form, run with cwd = the staged run dir. */
  command: string[];
  /** Relative paths that must exist after the command for `delivered`. */
  expect_outputs?: string[];
  description?: string;
}

/** A ProbeScenarioSpec resolved into the shape runProbe/session specs take. */
export interface LoadedProbeScenario {
  name: string;
  scenarioDir: string;
  command: string[];
  expectOutputs: string[];
  description?: string;
}

export function loadProbeScenario(specPath: string): LoadedProbeScenario {
  const resolved = assertSafeRepositoryPath(specPath);
  const parsed = loadJson<ProbeScenarioSpec>(resolved);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`[EVAL_SCENARIO] spec must be a JSON object, got ${typeof parsed}`);
  }
  if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
    throw new Error('[EVAL_SCENARIO] name must be a non-empty string');
  }
  if (typeof parsed.workspace_dir !== 'string' || !parsed.workspace_dir.trim()) {
    throw new Error('[EVAL_SCENARIO] workspace_dir must be a non-empty string');
  }
  // Guard first so an out-of-repo or unresolvable workspace_dir surfaces as a
  // spec error, not a raw secure-io rejection.
  let scenarioDir: string;
  try {
    scenarioDir = assertSafeRepositoryPath(parsed.workspace_dir, { allowMissingLeaf: true });
  } catch (error) {
    throw new Error(
      `[EVAL_SCENARIO] workspace_dir is not a safe in-repo path: ${parsed.workspace_dir} — ${
        error instanceof Error ? error.message : error
      }`
    );
  }
  if (!safeExistsSync(scenarioDir) || !safeLstat(scenarioDir).isDirectory()) {
    throw new Error(
      `[EVAL_SCENARIO] workspace_dir missing or not a directory: ${parsed.workspace_dir}`
    );
  }
  if (
    !Array.isArray(parsed.command) ||
    !parsed.command.length ||
    parsed.command.some((a) => typeof a !== 'string' || !a.trim())
  ) {
    throw new Error('[EVAL_SCENARIO] command must be a non-empty argv array of strings');
  }
  const expectOutputs = parsed.expect_outputs ?? [];
  if (!Array.isArray(expectOutputs)) {
    throw new Error('[EVAL_SCENARIO] expect_outputs must be an array of relative paths');
  }
  // Same rule as ProbeSpec.expectOutputs: checked inside the run dir, so a
  // traversal entry would let an unrelated file fake delivered.
  for (const rel of expectOutputs) {
    if (typeof rel !== 'string' || !isValidRelPath(rel)) {
      throw new Error(`[EVAL_SCENARIO] invalid expect_outputs path ${JSON.stringify(rel)}`);
    }
  }
  return {
    name: parsed.name,
    scenarioDir,
    command: parsed.command,
    expectOutputs,
    ...(parsed.description ? { description: parsed.description } : {}),
  };
}
