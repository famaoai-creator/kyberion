import { runExternalOperationSync } from '../governance/external-operation.js';
import type { VcsCommandResult } from './git.js';

/** Canonical synchronous transport boundary; authority comes from the trusted
 * runtime context, never argv/options supplied by an action. */
export function governVcsCommand(
  operationId: string,
  effect: Record<string, unknown>,
  execute: () => VcsCommandResult,
  mutation: boolean
): VcsCommandResult {
  return runExternalOperationSync(
    {
      operationId,
      effect,
      requiresApproval: mutation,
      // VCS mutations may consult an exact repository grant. Push merges and
      // sends resolve against the charter's repository+branch targets.
      delegable:
        operationId === 'vcs:pr_create' ||
        operationId === 'vcs:pr_merge' ||
        operationId === 'vcs:push',
    },
    execute,
    (result) =>
      result.status === 0 && !result.error ? 'succeeded' : mutation ? 'unknown' : 'failed'
  );
}
