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

import type { DotCharter, LoadedDotCharter } from '@agent/core/dot/dot-charter';
import {
  DOT_EXECUTOR_TASK_SESSION_GUIDANCE,
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
import { getReasoningBackend } from '@agent/core/reasoning/reasoning-backend';
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
  charter: DotCharter
): Promise<{ status: 'succeeded' | 'failed'; summary: string }> {
  const { executePipelineFile } = await import('./pipeline-execution-part-results.js');
  const result = await executePipelineFile(ref, {
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

function goalModeOf(resolution: DotWakeBackendResolution): DotGoalMode {
  if (resolution.mode === 'unavailable') return { unavailable: resolution.reason };
  return resolution.mode === 'tool' ? 'tool' : 'delegated';
}

/** Real executor ports for one charter. */
export function buildDotExecutorPorts(
  charter: DotCharter,
  deps: DotExecutorStepDeps = {}
): DotExecutorPorts {
  const backend = deps.backend ?? getReasoningBackend();
  const resolution = resolveDotWakeBackend(charter, backend, {
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
      if (!resolved) throw new Error('no reasoning backend resolved for the goal turn');
      const result = await drive({ ...options, backend: options.backend ?? resolved });
      return {
        ...result,
        finalText: result.finalReport ?? result.goal.terminalReason,
      };
    },
    async delegateText(prompt, timeoutMs, signal) {
      if (!resolved) throw new Error('no reasoning backend resolved for the delegated turn');
      return await delegateDotText(resolved, prompt, timeoutMs, signal);
    },
    runPipeline: (ref, ctx) => (deps.executePipeline ?? defaultExecutePipeline)(ref, ctx, charter),
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
