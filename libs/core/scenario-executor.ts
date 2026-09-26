/**
 * ES-05: scenario executor.
 *
 * Runs one `kyberion-scenario.v1` definition end to end: lane / deferral /
 * requirement gating (anything unmet is `skipped`, never `pass`), an
 * isolated run context, the virtual clock bound for the duration, the seed
 * materialized before the interceptor snapshots its write baseline, turns in
 * order, then final checks — and everything torn down in `finally`.
 *
 * Pipeline execution lives in `scripts/` (the engine is not part of
 * libs/core), so it is injected as `runPipeline`; `scripts/scenario_runner.ts`
 * provides the in-process implementation.
 */

import * as path from 'node:path';
import { setClock } from './foundation/clock.js';
import { redactSensitiveObject } from './network.js';
import { pathResolver } from './path-resolver.js';
import { getLastServedReasoningMode, type LastServedReasoningMode } from './reasoning-backend.js';
import type {
  ScenarioDefinition,
  ScenarioLane,
  ScenarioPipelineTurn,
  ScenarioTurn,
} from './scenario-definition.js';
import { evidenceClassForProfile } from './scenario-evidence-class.js';
import {
  evaluateFinalCheck,
  evaluateTurnChecks,
  type ScenarioCheckResult,
  type ScenarioSeqWindow,
} from './scenario-final-checks.js';
import { installScenarioInterceptor, type ScenarioInterceptor } from './scenario-interceptor.js';
import { evaluateJudgeCheck, observedActorBackends, type JudgeBackend } from './scenario-judge.js';
import {
  buildScenarioReport,
  type ScenarioReport,
  type ScenarioRunStatus,
  type ScenarioTurnReport,
} from './scenario-report.js';
import { createScenarioRunContext, type ScenarioRunContext } from './scenario-run-context.js';
import type { ScenarioSideEffectLog } from './scenario-side-effect-log.js';
import { exportTrajectory, type TrajectoryRecord } from './scenario-trajectory.js';
import { assertSafeRepositoryPath, ensureDir, safeExistsSync, safeWriteFile } from './secure-io.js';
import { TraceContext, type Trace } from './src/trace.js';

export interface ScenarioPipelineRunRequest {
  /** Inline steps, or undefined when `pipelinePath` is set. */
  steps?: readonly Record<string, unknown>[];
  /** Absolute, repository-contained pipeline file path. */
  pipelinePath?: string;
  context: Record<string, unknown>;
  trace: TraceContext;
}

export interface ScenarioPipelineRunResult {
  status?: string;
  results?: readonly { op?: string; status?: string; error?: string }[];
  context?: Record<string, unknown>;
}

export type ScenarioPipelineRunner = (
  request: ScenarioPipelineRunRequest
) => Promise<ScenarioPipelineRunResult>;

export interface RunScenarioOptions {
  /** Only run scenarios of this lane; others report `lane_skipped`. */
  lane?: ScenarioLane;
  /** Keep the run root after the run (debugging). */
  keep?: boolean;
  /** Receives the absolute per-invocation run root (e.g. to report a kept root). */
  onRunRoot?: (runRoot: string) => void;
  /** Build the trajectory and hand it to `onTrajectory`. */
  exportTrajectory?: boolean;
  onTrajectory?: (trajectory: TrajectoryRecord) => void;
  /** Directory pipeline-turn paths are resolved against (the scenario file's directory). */
  baseDir?: string;
  seedNonce?: string;
  /** In-process pipeline execution; required when the scenario has pipeline turns. */
  runPipeline?: ScenarioPipelineRunner;
  /** Live backend for intent turns (live-only); absent ⇒ such scenarios are skipped. */
  liveBackend?: JudgeBackend;
  /** Judge backend for judge checks (live-only); absent ⇒ such scenarios are skipped. */
  judgeBackend?: JudgeBackend;
  env?: Record<string, string | undefined>;
  actuatorAvailable?: (id: string) => boolean;
  /** Backend names considered available for `requires.backends`. */
  availableBackends?: readonly string[];
  /** Wall-clock source for `wall_ms` only. */
  wallNow?: () => number;
}

/** Runner-owned artifact of a pipeline turn (redacted final context), relative to the run root. */
export function scenarioTurnArtifactPath(index: number): string {
  return `turns/${index}.context.json`;
}

function defaultActuatorAvailable(id: string): boolean {
  const name = id.endsWith('-actuator') ? id : `${id}-actuator`;
  return safeExistsSync(pathResolver.rootResolve(`libs/actuators/${name}`));
}

function unmetRequirements(def: ScenarioDefinition, options: RunScenarioOptions): string[] {
  const env = options.env ?? process.env;
  const actuatorAvailable = options.actuatorAvailable ?? defaultActuatorAvailable;
  const backends = new Set(
    (
      options.availableBackends ??
      [options.liveBackend?.name, options.judgeBackend?.name].filter((name): name is string =>
        Boolean(name)
      )
    ).map((name) => name.toLowerCase())
  );
  return [
    ...(def.requires.env ?? []).filter((name) => !env[name]).map((name) => `env ${name}`),
    ...(def.requires.actuators ?? [])
      .filter((id) => !actuatorAvailable(id))
      .map((id) => `actuator ${id}`),
    ...(def.requires.backends ?? [])
      .filter((name) => !backends.has(name.toLowerCase()))
      .map((name) => `backend ${name}`),
  ];
}

/** Why the scenario cannot run in this invocation, or null when it can. */
function gateReason(
  def: ScenarioDefinition,
  options: RunScenarioOptions
): { status: ScenarioRunStatus; reason: string } | null {
  if (options.lane && def.lane !== options.lane) {
    return {
      status: 'lane_skipped',
      reason: `scenario lane ${def.lane} is outside the requested lane ${options.lane}`,
    };
  }
  if (def.deferred) return { status: 'skipped', reason: `deferred: ${def.deferred.reason}` };
  const unmet = unmetRequirements(def, options);
  if (unmet.length > 0) {
    return { status: 'skipped', reason: `unmet requirements: ${unmet.join(', ')}` };
  }
  if (def.turns.some((turn) => turn.kind === 'intent') && !options.liveBackend) {
    return {
      status: 'skipped',
      reason: 'intent turns need a live reasoning backend (none available)',
    };
  }
  if (def.turns.some((turn) => turn.checks?.judge) && !options.judgeBackend) {
    return { status: 'skipped', reason: 'judge checks need a judge backend (none available)' };
  }
  if (def.turns.some((turn) => turn.kind === 'pipeline') && !options.runPipeline) {
    return { status: 'error', reason: 'pipeline turns need an injected pipeline runner' };
  }
  return null;
}

function maxSeq(log: ScenarioSideEffectLog): number {
  return Math.max(
    0,
    ...[log.ops, log.approvals, log.writes, log.reasoning].map((list) => list.at(-1)?.seq ?? 0)
  );
}

function resolvePipelinePath(turn: ScenarioPipelineTurn, baseDir: string): string {
  const resolved = path.resolve(baseDir, turn.pipeline!);
  return assertSafeRepositoryPath(resolved);
}

interface TurnOutcome {
  response: unknown;
  checks: ScenarioCheckResult[];
  error?: string;
}

/** Run every disposer even if an earlier one throws; returns the first failure. */
function disposeAll(disposers: ReadonlyArray<() => void>): { error: unknown } | undefined {
  let first: { error: unknown } | undefined;
  for (const dispose of disposers) {
    try {
      dispose();
    } catch (error) {
      first ??= { error };
    }
  }
  return first;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runPipelineTurn(
  turn: ScenarioPipelineTurn,
  def: ScenarioDefinition,
  ctx: ScenarioRunContext,
  trace: TraceContext,
  options: RunScenarioOptions
): Promise<TurnOutcome> {
  const baseDir = options.baseDir ?? pathResolver.rootDir();
  const context = {
    ...(def.seed.context ?? {}),
    ...(turn.context ?? {}),
    scenario_id: def.id,
    scenario_run_root: pathResolver.toRepoRelative(ctx.runRoot),
  };
  let failure: string | undefined;
  let response: Record<string, unknown> = {};
  try {
    const request: ScenarioPipelineRunRequest = turn.pipeline
      ? { pipelinePath: resolvePipelinePath(turn, baseDir), context, trace }
      : { steps: turn.steps ?? [], context, trace };
    const result = await options.runPipeline!(request);
    response = result.context ?? {};
    if (result.status !== 'succeeded') {
      failure =
        result.results?.find((entry) => entry.error)?.error ??
        `pipeline finished with status ${String(result.status)}`;
    }
  } catch (error) {
    failure = errorText(error);
  }

  if (turn.expectError !== undefined) {
    const matched = failure !== undefined && failure.includes(turn.expectError);
    return {
      response,
      checks: [
        {
          type: 'expectError',
          pass: matched,
          detail: matched
            ? `pipeline failed as expected (${turn.expectError})`
            : failure === undefined
              ? `pipeline succeeded but was expected to fail with ${turn.expectError}`
              : `pipeline failed with a different error: ${failure}`,
        },
      ],
    };
  }
  return { response, checks: [], ...(failure !== undefined ? { error: failure } : {}) };
}

function writeTurnArtifact(ctx: ScenarioRunContext, index: number, response: unknown): void {
  const target = path.join(ctx.runRoot, scenarioTurnArtifactPath(index));
  ensureDir(path.dirname(target));
  safeWriteFile(target, `${JSON.stringify(redactSensitiveObject(response ?? {}), null, 2)}\n`);
}

/** Run one scenario and return its `kyberion-scenario-report.v1` report. */
export async function runScenario(
  def: ScenarioDefinition,
  options: RunScenarioOptions = {}
): Promise<ScenarioReport> {
  const wallNow = options.wallNow ?? (() => performance.now());
  const wallStart = wallNow();
  const gate = gateReason(def, options);
  if (gate) {
    return buildScenarioReport({
      def,
      runId: createScenarioRunContext(def, { seedNonce: options.seedNonce }).runId,
      status: gate.status,
      reason: gate.reason,
      startedAtMs: 0,
      finishedAtMs: 0,
      wallMs: 0,
    });
  }

  const ctx = createScenarioRunContext(def, { seedNonce: options.seedNonce, keep: options.keep });
  options.onRunRoot?.(ctx.runRoot);
  const startedAtMs = ctx.clock.now();
  const turns: ScenarioTurnReport[] = [];
  const finalChecks: ScenarioCheckResult[] = [];
  const turnResponses = new Map<number, unknown>();
  const served: (LastServedReasoningMode | null)[] = [];
  const transcript: string[] = [];
  let interceptor: ScenarioInterceptor | undefined;
  let disposeClock: (() => void) | undefined;
  let status: ScenarioRunStatus = 'pass';
  let reason: string | undefined;
  let finishedAtMs = startedAtMs;
  let finalTrace: Trace | undefined;

  try {
    disposeClock = setClock(ctx.clock);
    ctx.materializeSeedFiles();
    const active = installScenarioInterceptor(ctx, def);
    interceptor = active;
    const trace = new TraceContext(`scenario:${def.id}`, { pipelineId: `scenario:${def.id}` });

    // FU-01: turns run inside the run's async scope; the interceptor's seams
    // ignore every call made outside it (other work in this process).
    await active.runInScope(async () => {
      for (const [index, turn] of def.turns.entries()) {
        const turnStartMs = ctx.clock.now();
        const window: ScenarioSeqWindow = { fromSeq: maxSeq(active.log) + 1, toSeq: 0 };
        trace.startSpan('scenario.turn', { index, kind: turn.kind });
        const outcome = await runTurn(turn, index, def, ctx, active, trace, options, served);
        active.snapshotWrites();
        window.toSeq = maxSeq(active.log) + 1;
        if (turn.kind === 'pipeline') turnResponses.set(index, outcome.response);
        if (turn.kind === 'intent') {
          transcript.push(
            `USER: ${turn.text}`,
            `AGENT: ${String((outcome.response as { response?: unknown }).response ?? '')}`
          );
        }

        const checks = [
          ...outcome.checks,
          ...evaluateTurnChecks(turn.checks, active.log, window, outcome.response),
        ];
        if (turn.checks?.judge) {
          checks.push(
            await evaluateJudgeCheck(
              turn.checks.judge,
              transcript.join('\n'),
              observedActorBackends(active.log, served),
              options.judgeBackend
            )
          );
        }
        const turnStatus = outcome.error ? 'fail' : checks.every((c) => c.pass) ? 'pass' : 'fail';
        trace.endSpan(turnStatus === 'pass' ? 'ok' : 'error', outcome.error);
        turns.push({
          index,
          kind: turn.kind,
          status: turnStatus,
          checks,
          duration_ms: ctx.clock.now() - turnStartMs,
          ...(outcome.error ? { error: outcome.error } : {}),
        });
      }
    });

    for (const [index, response] of turnResponses) writeTurnArtifact(ctx, index, response);
    finalTrace = trace.finalize();
    for (const check of def.finalChecks) {
      finalChecks.push(evaluateFinalCheck(check, interceptor.log, finalTrace, ctx));
    }
    const failed = turns.some((turn) => turn.status !== 'pass') || finalChecks.some((c) => !c.pass);
    status = failed ? 'fail' : 'pass';
  } catch (error) {
    status = 'error';
    reason = errorText(error);
  } finally {
    finishedAtMs = ctx.clock.now();
    const failure = disposeAll([() => interceptor?.dispose(), () => disposeClock?.()]);
    if (failure) {
      ctx.dispose();
      throw failure.error;
    }
  }

  try {
    if (options.exportTrajectory && interceptor) {
      options.onTrajectory?.(
        exportTrajectory(finalTrace, interceptor.log, {
          scenarioId: def.id,
          runId: ctx.runId,
          evidenceClass: evidenceClassForProfile(def.executionProfile),
        })
      );
    }
    return buildScenarioReport({
      def,
      runId: ctx.runId,
      status,
      ...(reason ? { reason } : {}),
      turns,
      finalChecks,
      ...(interceptor ? { log: interceptor.log } : {}),
      startedAtMs,
      finishedAtMs,
      wallMs: Math.max(0, Math.round(wallNow() - wallStart)),
    });
  } finally {
    ctx.dispose();
  }
}

async function runTurn(
  turn: ScenarioTurn,
  index: number,
  def: ScenarioDefinition,
  ctx: ScenarioRunContext,
  interceptor: ScenarioInterceptor,
  trace: TraceContext,
  options: RunScenarioOptions,
  served: (LastServedReasoningMode | null)[]
): Promise<TurnOutcome> {
  switch (turn.kind) {
    case 'pipeline':
      return runPipelineTurn(turn, def, ctx, trace, options);
    case 'advance_clock':
      ctx.clock.advance(turn.ms);
      return { response: { now_ms: ctx.clock.now() }, checks: [] };
    case 'approval_decision':
      interceptor.setApprovalDecision(turn.op, turn.decision);
      return { response: { op: turn.op, decision: turn.decision }, checks: [] };
    case 'intent': {
      const before = getLastServedReasoningMode();
      try {
        const response = await options.liveBackend!.prompt(turn.text);
        const after = getLastServedReasoningMode();
        if (after && after !== before) served.push(after);
        return { response: { response }, checks: [] };
      } catch (error) {
        return { response: {}, checks: [], error: `turn ${index}: ${errorText(error)}` };
      }
    }
    default: {
      const unreachable: never = turn;
      throw new Error(`[SCENARIO_INVALID] unknown turn kind ${String(unreachable)}`);
    }
  }
}
