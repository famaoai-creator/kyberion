/**
 * Dot executor supervisor step (DL-01) — wires the real ports into
 * `runDotExecutorSweep` and registers as the `dot-executor` step.
 *
 * Ports, resolved once per charter per sweep:
 *   - goal turn  → `runGoalDrivenLoop` with the backend `resolveDotWakeBackend`
 *                  chose (passed explicitly so the loop never re-resolves the stub);
 *   - delegated  → one `delegateTask` / `delegateTaskHandle` turn bounded by the
 *                  charter wall-clock budget, used when no live tool candidate exists;
 *   - pipeline   → in-process `executePipelineFile`, loaded lazily so the daemon
 *                  does not pay the pipeline engine's import cost on start.
 * An unconfigured stub backend leaves conversational items unclaimed.
 */

import type { DotCharter, LoadedDotCharter } from '@agent/core/dot/dot-charter';
import {
  runDotExecutorSweep,
  type DotExecutorDeps,
  type DotExecutorPorts,
  type DotGoalMode,
} from '@agent/core/dot/dot-executor';
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

/** Bounded delegated turn (same shape as the dot runtime's delegated wake). */
export async function delegateDotText(
  backend: DotWakeBackend,
  prompt: string,
  timeoutMs: number
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
  try {
    if (backend.delegateTaskHandle) {
      const handle = backend.delegateTaskHandle(prompt, undefined);
      return await Promise.race([
        handle.join(),
        timeout(
          () => void handle.cancel(`wall_clock budget ${timeoutMs}ms exceeded`).catch(() => {})
        ),
      ]);
    }
    return await Promise.race([backend.delegateTask(prompt, undefined), timeout()]);
  } finally {
    if (timer) clearTimeout(timer);
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
    goalMode: () => goalModeOf(resolution),
    async runGoalTurn(options) {
      if (!resolved) throw new Error('no reasoning backend resolved for the goal turn');
      const result = await drive({ ...options, backend: options.backend ?? resolved });
      return {
        ...result,
        finalText: result.finalReport ?? result.goal.terminalReason,
      };
    },
    async delegateText(prompt, timeoutMs) {
      if (!resolved) throw new Error('no reasoning backend resolved for the delegated turn');
      return await delegateDotText(resolved, prompt, timeoutMs);
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
