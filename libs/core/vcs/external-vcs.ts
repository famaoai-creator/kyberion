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
      // Only PR creation may consult an exact repository grant. Merge/push stay human-only.
      delegable: operationId === 'vcs:pr_create',
    },
    execute,
    (result) =>
      result.status === 0 && !result.error ? 'succeeded' : mutation ? 'unknown' : 'failed'
  );
}
