import { governedWorkerEnv } from '../server-child-env';
/**
 * D3 (MSN-KYBERION-SERVER-20261104): the Kyberion server never assumes the
 * dot lifecycle store roles (`dot_charter_store` /
 * `dot_lifecycle_runtime_store`; the former `dot_lifecycle_writer` was
 * decomposed in MSN-SCOPE-FLOWDECOMP-20261107).
 * `/api/ops/workspace/autonomy` plans the change
 * read-only (`planWorkspaceAutonomyControl`: operator role, workplace
 * ownership, viewer visibility, status, admission hash) and dispatches the
 * write to the governed worker `scripts/dot/dot_lifecycle_worker.ts`, launched as a
 * child under its own system role. The worker re-validates every expectation
 * inside the charter lock and fails closed on a mismatch. Each dispatch is
 * audited as `governed_worker_dispatch`.
 */
import type { WorkspaceAutonomyControlPlan } from '@agent/core/surface/workspace-autonomy';

export const DOT_LIFECYCLE_WORKER_SCRIPT = 'dist/scripts/dot/dot_lifecycle_worker.js';
export const DOT_LIFECYCLE_WORKER_ROLE = 'dot_lifecycle_worker';
const DOT_LIFECYCLE_WORKER_TIMEOUT_MS = 60_000;

type WorkerResult = { stdout: string; stderr: string; status: number | null; error?: Error };
type WorkerAudit = {
  action: string;
  dotId: string;
  /** `error` + outcome `unconfirmed`: the worker may or may not have written (timeout). */
  result: 'completed' | 'failed' | 'denied' | 'error';
  outcome?: 'unconfirmed';
  actor?: string;
  reason?: string;
};

export interface DotLifecycleDispatchDeps {
  run?: (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number }
  ) => Promise<WorkerResult>;
  audit?: (entry: WorkerAudit) => void;
}

const UNCONFIRMED_MESSAGE =
  'Autonomy control outcome is unconfirmed; refresh the workplace to verify the state.';

/** Audit a plan-time refusal (viewer, scope, status, admission): the worker never ran. */
export async function auditDotLifecycleDenial(
  input: { action: string; dotId: string; actor?: string; reason: string },
  deps: Pick<DotLifecycleDispatchDeps, 'audit'> = {}
): Promise<void> {
  const entry: WorkerAudit = {
    action: input.action,
    dotId: input.dotId,
    result: 'denied',
    reason: input.reason,
    ...(input.actor ? { actor: input.actor } : {}),
  };
  if (deps.audit) return deps.audit(entry);
  try {
    const { auditChain } = await import('@agent/core/governance/audit-chain');
    auditChain.record({
      agentId: entry.actor || 'concierge-ops-console',
      action: 'governed_worker_dispatch',
      operation: `dot_lifecycle:${entry.action}`,
      result: 'denied',
      reason: entry.reason,
      metadata: {
        worker: DOT_LIFECYCLE_WORKER_SCRIPT,
        system_role: DOT_LIFECYCLE_WORKER_ROLE,
        dot_id: entry.dotId,
        stage: 'plan',
      },
    });
  } catch {
    // Observability must not turn a refusal into a 500.
  }
}

export class DotLifecycleDispatchError extends Error {
  constructor(
    message: string,
    public readonly conflict: boolean
  ) {
    super(message);
    this.name = 'DotLifecycleDispatchError';
  }
}

export function dotLifecycleWorkerArgs(
  plan: WorkspaceAutonomyControlPlan,
  actor?: string
): string[] {
  return [
    DOT_LIFECYCLE_WORKER_SCRIPT,
    plan.action,
    plan.dot_id,
    '--expect-status',
    plan.expectedStatus,
    '--expect-admission-hash',
    plan.expectedAdmissionScopeHash,
    '--expect-scope-json',
    JSON.stringify(plan.expectedScope),
    ...(actor ? ['--actor', actor] : []),
    '--json',
  ];
}

export async function dispatchDotLifecycleWorker(
  plan: WorkspaceAutonomyControlPlan,
  actor: string | undefined,
  deps: DotLifecycleDispatchDeps = {}
): Promise<{ dot_id: string; status: string }> {
  const [secureIo, paths, audit] = await Promise.all([
    import('@agent/core/secure-io'),
    import('@agent/core/path-resolver'),
    import('@agent/core/governance/audit-chain'),
  ]);
  const run = deps.run ?? secureIo.safeExecResultAsync;
  const record =
    deps.audit ??
    ((entry: WorkerAudit) =>
      audit.auditChain.record({
        agentId: entry.actor || 'concierge-ops-console',
        action: 'governed_worker_dispatch',
        operation: `dot_lifecycle:${entry.action}`,
        result: entry.result,
        ...(entry.reason ? { reason: entry.reason } : {}),
        metadata: {
          worker: DOT_LIFECYCLE_WORKER_SCRIPT,
          system_role: DOT_LIFECYCLE_WORKER_ROLE,
          dot_id: entry.dotId,
          ...(entry.outcome ? { outcome: entry.outcome } : {}),
        },
      }));
  const env = governedWorkerEnv(DOT_LIFECYCLE_WORKER_ROLE);
  const base = { action: plan.action, dotId: plan.dot_id, ...(actor ? { actor } : {}) };
  let result: WorkerResult;
  try {
    result = await run('node', dotLifecycleWorkerArgs(plan, actor), {
      cwd: paths.pathResolver.rootDir(),
      env,
      timeoutMs: DOT_LIFECYCLE_WORKER_TIMEOUT_MS,
    });
  } catch (error) {
    // The worker could not be started: nothing ran, but the attempt is audited.
    const reason = error instanceof Error ? error.message : String(error);
    record({ ...base, result: 'failed', reason });
    throw new DotLifecycleDispatchError(reason, false);
  }
  if (result.status === null) {
    // Killed (timeout / output limit): the transition may or may not have landed.
    record({
      ...base,
      result: 'error',
      outcome: 'unconfirmed',
      reason: 'dot lifecycle worker did not finish',
    });
    throw new DotLifecycleDispatchError(UNCONFIRMED_MESSAGE, false);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.error?.message || 'dot lifecycle worker failed').trim();
    const reason = detail.split('\n').slice(-1)[0] ?? detail;
    record({ ...base, result: 'failed', reason });
    const conflict = /DOT_TRANSITION_CONFLICT|DOT_ADMISSION/i.test(detail);
    throw new DotLifecycleDispatchError(
      conflict ? 'Autonomy changed; refresh the workplace before retrying.' : reason,
      conflict
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    parsed = undefined;
  }
  const report = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  if (report.ok !== true || report.dot_id !== plan.dot_id || report.status !== plan.target) {
    record({
      ...base,
      result: 'error',
      outcome: 'unconfirmed',
      reason: 'unconfirmed worker result',
    });
    throw new DotLifecycleDispatchError(UNCONFIRMED_MESSAGE, false);
  }
  record({ ...base, result: 'completed' });
  return { dot_id: plan.dot_id, status: plan.target };
}
