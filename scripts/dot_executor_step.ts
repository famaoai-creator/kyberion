import {
  findDotCharter,
  isFrontDeskDiagnosticDot,
  requireCurrentFrontDeskDiagnosticDot,
} from '@agent/core/dot/dot-charter';
import {
  frontDeskMappingDigest,
  getFrontDeskExecutionMapping,
} from '@agent/core/surface/front-desk-execution-contract';
/**
 * Dot executor supervisor step (DL-01) — wires the real ports into
 * `runDotExecutorSweep` and registers as the `dot-executor` step.
 *
 * Ports, resolved once per charter per sweep:
 *   - goal turn  → read-only direct replies via `runGoalDrivenLoop` with the
 *                  backend `resolveDotWakeBackend` chose; task_session is
 *                  refused until a governed work-tool executor is available;
 *   - delegated  → one advisory (`planner` profile requested) `delegateTask` /
 *                  `delegateTaskHandle` turn bounded by the charter wall-clock
 *                  budget, receiving a cancellation request on abort, used when
 *                  no live tool candidate exists;
 *   - pipeline   → in-process `executePipelineFile`, loaded lazily so the daemon
 *                  does not pay the pipeline engine's import cost on start.
 * The goal driver and pipeline engine accept no AbortSignal: on the executor's
 * wall-clock deadline they may keep running (the goal driver has its own
 * wall-clock bound), so the executor quarantines the uncertain outcome.
 * An unconfigured stub backend leaves conversational items unclaimed.
 */

import { getWorkItem } from '@agent/core/workforce/work-coordination';
import {
  FRONT_DESK_RECEIPT_PIPELINE,
  prepareFrontDeskExecution,
} from '@agent/core/surface/front-desk-execution';
import type { DotCharter, LoadedDotCharter } from '@agent/core/dot/dot-charter';
import {
  DOT_EXECUTOR_TASK_SESSION_GUIDANCE,
  DotExecutorPreEffectError,
  runDotExecutorSweep,
  type DotExecutorDeps,
  type DotExecutorPorts,
  type DotGoalMode,
} from '@agent/core/dot/dot-executor';
import '@agent/core/dot/dot-extension-bootstrap';
import {
  resolveDotWakeBackend,
  type DotWakeBackend,
  type DotWakeBackendResolution,
} from '@agent/core/dot/dot-wake-backend';
import type { DotWorkResultRow } from '@agent/core/dot/dot-state-paths';
import { createLogger } from '@agent/core/logger';
import {
  getReasoningBackend,
  type ReasoningBackend,
} from '@agent/core/reasoning/reasoning-backend';
import { runGoalDrivenLoop } from '@agent/core/workforce/worker-goal-driver';
import type { DotSupervisorStep } from './dot_supervisor_extensions.js';

const logger = createLogger('dot-executor-step');

export interface DotExecutorStepDeps extends DotExecutorDeps {
  /** Process backend (test seam); defaults to getReasoningBackend(). */
  backend?: DotWakeBackend;
  goalDriver?: typeof runGoalDrivenLoop;
  executePipeline?: (
    ref: string,
    ctx: Record<string, unknown>,
    charter: DotCharter
  ) => Promise<{ status: 'succeeded' | 'failed'; summary: string }>;
  maxPerSweep?: number;
}

/**
 * Request advice-only behavior. Provider restrictions differ: this option is
 * not proof that native tools or writes are mechanically impossible.
 */
export const DOT_EXECUTOR_DELEGATE_OPTIONS = { advisory: true, profile: 'planner' } as const;

/** Bounded advisory turn; cancellation and absence of effects remain unverified. */
export async function delegateDotText(
  backend: DotWakeBackend,
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = (onTimeout?: () => void) =>
    new Promise<string>((_resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`delegated executor turn exceeded wall_clock budget ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    });
  let onAbort: (() => void) | undefined;
  const aborted = (cancel?: (reason: string) => void) =>
    new Promise<string>((_resolve, reject) => {
      if (!signal) return;
      onAbort = () => {
        cancel?.('executor wall_clock deadline reached');
        reject(new Error('delegated executor turn aborted by the executor deadline'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  const options = { ...DOT_EXECUTOR_DELEGATE_OPTIONS, ...(signal ? { signal } : {}) };
  try {
    if (backend.delegateTaskHandle) {
      const handle = backend.delegateTaskHandle(prompt, undefined, options);
      const cancel = (reason: string) => void handle.cancel(reason).catch(() => {});
      return await Promise.race([
        handle.join(),
        timeout(() => cancel(`wall_clock budget ${timeoutMs}ms exceeded`)),
        aborted(cancel),
      ]);
    }
    return await Promise.race([
      backend.delegateTask(prompt, undefined, options),
      timeout(),
      aborted(),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function defaultExecutePipeline(
  ref: string,
  ctx: Record<string, unknown>,
  charter: DotCharter,
  deps: DotExecutorStepDeps = {}
): Promise<{ status: 'succeeded' | 'failed'; summary: string }> {
  const { executePipelineFile } = await import('./pipeline-execution-part-results.js');
  try {
    // Preflight: a missing or invalid pipeline fails before any step runs.
    const { readValidatedWorkflowAdf } = await import('./refactor/adf-input.js');
    await readValidatedWorkflowAdf(ref);
  } catch (error) {
    throw new DotExecutorPreEffectError(
      `pipeline '${ref}' could not be loaded: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (ref === FRONT_DESK_RECEIPT_PIPELINE) {
    const item = typeof ctx.work_item_id === 'string' ? getWorkItem(ctx.work_item_id) : null;
    if (!item) throw new DotExecutorPreEffectError('bound front-desk WorkItem missing');
    const current =
      charter.runtime.execution_mode !== undefined
        ? requireCurrentFrontDeskDiagnosticDot(charter, deps.rootDir)
        : charter;
    const prepared = prepareFrontDeskExecution(current, item, deps);
    if (
      ctx.front_desk_output_path !== prepared.outputPath ||
      ctx.front_desk_artifact_content !== prepared.expectedContent
    )
      throw new DotExecutorPreEffectError('front-desk pipeline input binding changed');
  }
  const diagnostic = isFrontDeskDiagnosticDot(charter);
  const result = await executePipelineFile(ref, {
    ...(diagnostic
      ? {
          executionMode: 'front_desk_diagnostic' as const,
          validateLoadedPipeline: (_pipeline: unknown, source: string) => {
            const current = requireCurrentFrontDeskDiagnosticDot(charter, deps.rootDir);
            const item =
              typeof ctx.work_item_id === 'string' ? getWorkItem(ctx.work_item_id) : null;
            if (!item) throw new DotExecutorPreEffectError('bound front-desk WorkItem missing');
            const prepared = prepareFrontDeskExecution(current, item, deps);
            const mapping = getFrontDeskExecutionMapping(prepared.binding);
            if (
              !mapping ||
              frontDeskMappingDigest(mapping, source) !== prepared.binding.config_digest ||
              ctx.front_desk_output_path !== prepared.outputPath ||
              ctx.front_desk_artifact_content !== prepared.expectedContent
            )
              throw new DotExecutorPreEffectError(
                'loaded diagnostic pipeline or bound inputs changed'
              );
          },
        }
      : {}),
    context: { ...ctx, dot_executor: true },
    quiet: true,
    hasHuman: false,
    payloadScope: {
      tier: charter.scope.tier,
      ...(charter.scope.tenant_slug ? { tenant_slug: charter.scope.tenant_slug } : {}),
      purpose: `dot ${charter.dot_id} pipeline ${ref}`,
    },
  });
  const failed = result.results.filter((entry) => entry.status === 'failed');
  return failed.length === 0
    ? { status: 'succeeded', summary: `${result.results.length} step(s) succeeded` }
    : {
        status: 'failed',
        summary: `${failed.length} of ${result.results.length} step(s) failed${
          failed[0] && 'error' in failed[0] && failed[0].error ? `: ${String(failed[0].error)}` : ''
        }`,
      };
}

/**
 * Backend members verified (reasoning-backend-contracts.ts) never to reach a
 * model: identity, runtime notes, capability flags and session reset. Every
 * other function member — including ones added to the contract later — is
 * counted as a model call (fail closed: an unknown call may have had effects).
 * `getNativeSubagentAdopter` is deliberately absent: the adopter it returns
 * can run a model outside this observer.
 */
const NON_MODEL_MEMBERS = new Set<string>([
  'name',
  'supportsVision',
  'getRuntimeInstructions',
  'getRuntimeProviderName',
  'requiresNativeSubagent',
  'resetSession',
] satisfies ReadonlyArray<keyof ReasoningBackend>);

/**
 * Observer so the step can tell whether the goal driver reached the model at
 * all: a throw before the first model call cannot have caused effects. Every
 * function member is wrapped to run with `this` bound to the original backend
 * (never inherited through a prototype); any member outside
 * {@link NON_MODEL_MEMBERS} marks the model as reached.
 */
function observeBackendCalls<T extends object>(backend: T): { backend: T; called: () => boolean } {
  let called = false;
  const wrappers = new Map<PropertyKey, { original: unknown; wrapper: unknown }>();
  const observed = new Proxy(backend, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      const cached = wrappers.get(prop);
      if (cached?.original === value) return cached.wrapper;
      const reachesModel = typeof prop !== 'string' || !NON_MODEL_MEMBERS.has(prop);
      const wrapper = (...args: unknown[]) => {
        if (reachesModel) called = true;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
      wrappers.set(prop, { original: value, wrapper });
      return wrapper;
    },
  });
  return { backend: observed, called: () => called };
}

function goalModeOf(resolution: DotWakeBackendResolution): DotGoalMode {
  if (resolution.mode === 'unavailable') return { unavailable: resolution.reason };
  return resolution.mode === 'tool' ? 'tool' : 'delegated';
}

/** Real executor ports for one charter. */
export function buildDotExecutorPorts(
  charter: DotCharter,
  deps: DotExecutorStepDeps = {}
): DotExecutorPorts {
  const persisted = findDotCharter(charter.dot_id, deps.rootDir)?.charter;
  const diagnostic =
    isFrontDeskDiagnosticDot(charter) || Boolean(persisted && isFrontDeskDiagnosticDot(persisted));
  const resolution: DotWakeBackendResolution = diagnostic
    ? { mode: 'unavailable', reason: 'front_desk_diagnostic has no model execution' }
    : resolveDotWakeBackend(charter, deps.backend ?? getReasoningBackend(), {
        injected: deps.backend !== undefined,
      });
  const resolved = resolution.mode === 'unavailable' ? undefined : resolution.backend;
  const drive = deps.goalDriver ?? runGoalDrivenLoop;
  return {
    // The driver has goal-control tools only here: no discovered work tools or
    // executeTool port. A model's "complete" cannot prove task execution.
    taskSessionUnavailable: DOT_EXECUTOR_TASK_SESSION_GUIDANCE,
    goalMode: () => goalModeOf(resolution),
    async runGoalTurn(options) {
      if (!resolved)
        throw new DotExecutorPreEffectError('no reasoning backend resolved for the goal turn');
      const observed = observeBackendCalls(options.backend ?? resolved);
      let result: Awaited<ReturnType<typeof drive>>;
      try {
        result = await drive({ ...options, backend: observed.backend });
      } catch (error) {
        if (observed.called()) throw error;
        throw new DotExecutorPreEffectError(
          `goal driver failed before its first model call: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return {
        ...result,
        finalText: result.finalReport ?? result.goal.terminalReason,
      };
    },
    async delegateText(prompt, timeoutMs, signal) {
      if (!resolved) {
        throw new DotExecutorPreEffectError('no reasoning backend resolved for the delegated turn');
      }
      return await delegateDotText(resolved, prompt, timeoutMs, signal);
    },
    runPipeline: async (ref, ctx) => {
      if (diagnostic && ref !== FRONT_DESK_RECEIPT_PIPELINE)
        throw new DotExecutorPreEffectError(
          'diagnostic supports only the front-desk receipt pipeline'
        );
      return deps.executePipeline
        ? deps.executePipeline(ref, ctx, charter)
        : defaultExecutePipeline(ref, ctx, charter, deps);
    },
  };
}

/** One executor pass with real ports. */
export async function runDotExecutorStep(
  now: Date,
  active: LoadedDotCharter[],
  deps: DotExecutorStepDeps = {}
): Promise<DotWorkResultRow[]> {
  const rows = await runDotExecutorSweep(
    active,
    (charter) => buildDotExecutorPorts(charter, deps),
    { now: () => now, ...deps }
  );
  for (const row of rows) {
    if (row.status === 'skipped') {
      logger.debug(`executor skipped ${row.work_item_id} for ${row.dot_id}: ${row.summary}`);
    } else {
      logger.info(`executor ${row.status} ${row.work_item_id} for ${row.dot_id} (${row.mode})`);
    }
  }
  return rows;
}

export const DOT_EXECUTOR_SUPERVISOR_STEP: DotSupervisorStep = {
  id: 'dot-executor',
  async run(now, active) {
    await runDotExecutorStep(now, active);
  },
};
