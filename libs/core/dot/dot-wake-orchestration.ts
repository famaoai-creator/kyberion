/**
 * Dot wake orchestration wiring — resolves the wake backend once and injects
 * the goal-driven loop into the domain `runDotWake` port.
 *
 * Lives in the orchestration layer (filename matches `*orchestrat*`) so that
 * domain `dot-runtime` never imports `worker-goal-driver`. Scripts and the
 * supervisor daemon call this entry instead of composing the port themselves.
 *
 * The resolved backend is passed explicitly into `runGoalDrivenLoop`: the
 * driver otherwise re-resolves `getReasoningBackend()` itself, which is how a
 * wake that saw a tool-capable backend still died with "[GOAL_DRIVER] backend
 * lacks generateWithTools".
 */

import { runGoalDrivenLoop } from '../workforce/worker-goal-driver.js';
import { buildTaskReasoningBackend } from '../workforce/task-execution-port.js';
import { createLogger } from '../logger.js';
import type { ReasoningBackendMode } from '../reasoning/reasoning-backend-policy.js';
import type { LiveJudgmentInvokePort } from '../organization/semantic-judgment-live-provider.js';
import type { DotCharter, LoadedDotCharter } from './dot-charter.js';
import type { DotProposal } from './dot-proposals.js';
import type { DotSemanticLiveBudgetPort } from './dot-semantic-budget.js';
import { observeLiveDotProposals, reconcileDotSemanticFeedback } from './dot-semantic-loop.js';
import {
  runDotWake,
  type DotRuntimeDeps,
  type DotWakeReceipt,
  type DueDotTrigger,
} from './dot-runtime.js';
import {
  resolveDotWakeBackend,
  type DotWakeBackend,
  type ResolveDotWakeBackendOptions,
} from './dot-wake-backend.js';
import {
  dotCredentialAssignCommand,
  dotStandingLineage,
  withDotStandingBinding,
  type DotStandingDeps,
} from './dot-standing-binding.js';
// Supervisor-facing re-export: the reminder runs in the same dot sweep as the wakes.
export { remindDotCredentialGrantExpiry } from './dot-standing-binding.js';
// Wakes need the registered prompt sections / wake tools; the registry is a
// leaf, so the orchestration entry populates it.
import './dot-extension-bootstrap.js';

const logger = createLogger('dot-wake-orchestration');

export type DotWakeOrchestrationDeps = Omit<DotRuntimeDeps, 'runLoop' | 'backendUnavailable'> & {
  trigger?: DueDotTrigger;
  /** Named-backend lookup for `charter.runtime.reasoning_backend`. */
  backendFor?: ResolveDotWakeBackendOptions['backendFor'];
  /** Goal-driver port (test seam); defaults to `runGoalDrivenLoop`. */
  goalDriver?: typeof runGoalDrivenLoop;
  /** Standing-binding ports (test seam) for tenant dots. */
  standing?: DotStandingDeps;
  /** Claimed-task backend for a bound tenant wake; defaults to buildTaskReasoningBackend. */
  taskBackend?: (charter: DotCharter) => DotWakeBackend;
  /** Optional live semantic_judgment invoke port override (test seam). */
  liveSemanticInvoke?: LiveJudgmentInvokePort | null;
  /** Optional live semantic_judgment shared budget port override (test seam). */
  liveSemanticBudget?: DotSemanticLiveBudgetPort;
};

/**
 * A bound credential that did not serve the model call (no usable allocation
 * for the routed provider, or a CLI provider without an isolated environment)
 * is the tenant's configuration problem: keep the original code (classified
 * `credential_grant`) and add the command that fixes it. Wake accounting
 * (`dotPartial`) is preserved.
 */
function withCredentialNextStep(error: unknown, charter: DotCharter): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (
    !/\[CREDENTIAL_(?:KEY_UNAVAILABLE|PROVIDER_DENIED|ALLOCATION_DENIED)\]/.test(message) ||
    message.includes('| next:')
  )
    return error;
  const annotated = new Error(
    `${message} | next: give tenant ${charter.scope.tenant_slug} an API-provider allocation the dot's route can use (${dotCredentialAssignCommand(charter)}) or extend an expiring one (pnpm kyberion reasoning credentials allocations --tenant ${charter.scope.tenant_slug}) | evidence: active/shared/runtime/grants/confidential/${charter.scope.tenant_slug}/`
  );
  const partial = (error as { dotPartial?: unknown } | null)?.dotPartial;
  return partial ? Object.assign(annotated, { dotPartial: partial }) : annotated;
}

/** The claimed task's private chain for a bound tenant Dot run (wake or executor). */
export function dotBoundTaskBackend(charter: DotCharter): DotWakeBackend {
  // A private chain built inside the claimed-task binding; the process-global
  // chain belongs to the operator identity and is never borrowed.
  return buildTaskReasoningBackend({
    role: charter.authority.authority_role,
    ...(charter.runtime.reasoning_backend
      ? { mode: charter.runtime.reasoning_backend as ReasoningBackendMode }
      : {}),
  });
}

/**
 * Run one charter wake with the production goal-driven loop injected.
 *
 * A tenant dot (without an injected backend) runs as one claimed step of its
 * standing Issue, inside a trusted task credential binding
 * (dot-standing-binding.ts). When that binding cannot be established the wake
 * still runs through `runDotWake`, which records the classified refusal
 * (`[DOT_CREDENTIAL_GRANT_MISSING]` / `_EXPIRED` / `[DOT_STANDING_*]`) as a
 * failed wake: counted by the wake circuit, never a model call, never an
 * operator-credential fallback.
 */
export async function runDotWakeWithGoalDriver(
  loaded: LoadedDotCharter,
  deps: DotWakeOrchestrationDeps = {}
): Promise<DotWakeReceipt> {
  const {
    backendFor,
    goalDriver,
    standing,
    taskBackend,
    liveSemanticInvoke,
    liveSemanticBudget,
    ...runtimeDeps
  } = deps;
  const wake = (mode: { bound: boolean; refusal?: string }) =>
    runDotWake(loaded, {
      ...runtimeDeps,
      // The runtime re-reads and gates the charter first, including revisions and
      // malformed modes. No provider resolution happens for diagnostic wakes.
      resolveWakeExecution: async (current) => {
        if (mode.refusal) return { backendUnavailable: mode.refusal };
        const backend =
          deps.backend ??
          (mode.bound
            ? (taskBackend ?? dotBoundTaskBackend)(current)
            : (await import('../reasoning/reasoning-backend.js')).getReasoningBackend());
        const resolution = resolveDotWakeBackend(current, backend, {
          injected: deps.backend !== undefined,
          ...(backendFor && !mode.bound ? { backendFor } : {}),
        });
        if (resolution.mode === 'unavailable') return { backendUnavailable: resolution.reason };
        const drive = goalDriver ?? runGoalDrivenLoop;
        return {
          backend: resolution.backend,
          ...(resolution.mode === 'tool'
            ? {
                runLoop: (options) => {
                  const turn = drive({
                    ...options,
                    backend: options.backend ?? resolution.backend,
                  });
                  return mode.bound
                    ? turn.catch((error: unknown) => {
                        throw withCredentialNextStep(error, current);
                      })
                    : turn;
                },
              }
            : {}),
        };
      },
    });
  let receipt: DotWakeReceipt;
  // Injected backends are explicit hosts / test seams; tenantless dots need no binding.
  if (deps.backend !== undefined || !dotStandingLineage(loaded.charter)) {
    receipt = await wake({ bound: false });
  } else {
    let entered = false;
    try {
      receipt = await withDotStandingBinding(
        loaded,
        'wake',
        () => {
          entered = true;
          return wake({ bound: true });
        },
        standing
      );
    } catch (error) {
      if (entered) throw error;
      receipt = await wake({
        bound: false,
        refusal: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await runPostWakeLiveSemanticLoop(loaded.charter, receipt, {
    rootDir: deps.rootDir,
    now: deps.now,
    liveSemanticInvoke,
    liveSemanticBudget,
    hasOfflineFixture: deps.semanticJudgment !== undefined,
  });
  return receipt;
}

async function runPostWakeLiveSemanticLoop(
  charter: DotCharter,
  receipt: DotWakeReceipt,
  options: {
    rootDir?: string;
    now?: () => Date;
    liveSemanticInvoke?: LiveJudgmentInvokePort | null;
    liveSemanticBudget?: DotSemanticLiveBudgetPort;
    hasOfflineFixture: boolean;
  }
): Promise<void> {
  if (options.hasOfflineFixture || receipt.outcome !== 'delivered') return;
  const mode = charter.runtime.semantic_judgment?.mode ?? 'off';
  if (mode !== 'shadow' && mode !== 'advisory') return;
  try {
    const proposals: DotProposal[] = (receipt.actions ?? []).map(
      (action) =>
        action.admission?.proposal ?? {
          action_id: action.action_id,
          title: action.title,
          objective: action.objective,
          execution_shape: action.execution_shape,
          ...(action.pipeline_ref ? { pipeline_ref: action.pipeline_ref } : {}),
        }
    );
    const loopDeps = {
      rootDir: options.rootDir,
      now: options.now,
      invoke: options.liveSemanticInvoke,
      budget: options.liveSemanticBudget,
    };
    if (proposals.length > 0) {
      await observeLiveDotProposals(charter, proposals, loopDeps);
    }
    await reconcileDotSemanticFeedback(charter, loopDeps);
  } catch (error) {
    logger.warn(
      `[dot-wake-orchestration] post-wake semantic judgment loop skipped for ${charter.dot_id}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Executor counterpart: run one tenant item's execution as a claimed step of
 * the Dot's standing Issue (`DotExecutorDeps.runBound`).
 */
export function runDotExecutorItemBound<T>(
  loaded: LoadedDotCharter,
  run: () => Promise<T>,
  standing?: DotStandingDeps
): Promise<T> {
  return withDotStandingBinding(loaded, 'executor', run, standing);
}
