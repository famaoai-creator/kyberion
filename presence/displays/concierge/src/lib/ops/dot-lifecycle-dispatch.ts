/**
 * D3 (MSN-KYBERION-SERVER-20261104): the Kyberion server never assumes
 * `dot_lifecycle_writer`. `/api/ops/workspace/autonomy` plans the change
 * read-only (`planWorkspaceAutonomyControl`: operator role, workplace
 * ownership, viewer visibility, status, admission hash) and dispatches the
 * write to the governed worker `scripts/dot_lifecycle_worker.ts`, launched as a
 * child under its own system role. The worker re-validates every expectation
 * inside the charter lock and fails closed on a mismatch. Each dispatch is
 * audited as `governed_worker_dispatch`.
 */
import type { WorkspaceAutonomyControlPlan } from '@agent/core/surface/workspace-autonomy';

export const DOT_LIFECYCLE_WORKER_SCRIPT = 'dist/scripts/dot_lifecycle_worker.js';
export const DOT_LIFECYCLE_WORKER_ROLE = 'dot_lifecycle_worker';
const DOT_LIFECYCLE_WORKER_TIMEOUT_MS = 60_000;

type WorkerResult = { stdout: string; stderr: string; status: number | null; error?: Error };
type WorkerAudit = {
  action: string;
  dotId: string;
  result: 'completed' | 'failed';
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
  const [secureIo, authority, paths, audit] = await Promise.all([
    import('@agent/core/secure-io'),
    import('@agent/core/authority'),
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
        },
      }));
  const env = authority.buildSystemRoleLaunchEnv({}, DOT_LIFECYCLE_WORKER_ROLE, {
    persona: 'worker',
  }) as Record<string, string | undefined>;
  const result = await run('node', dotLifecycleWorkerArgs(plan, actor), {
    cwd: paths.pathResolver.rootDir(),
    env,
    timeoutMs: DOT_LIFECYCLE_WORKER_TIMEOUT_MS,
  });
  const base = { action: plan.action, dotId: plan.dot_id, ...(actor ? { actor } : {}) };
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
    record({ ...base, result: 'failed', reason: 'unconfirmed worker result' });
    throw new DotLifecycleDispatchError(
      'Autonomy control outcome is unconfirmed; refresh the workplace to verify the state.',
      false
    );
  }
  record({ ...base, result: 'completed' });
  return { dot_id: plan.dot_id, status: plan.target };
}
