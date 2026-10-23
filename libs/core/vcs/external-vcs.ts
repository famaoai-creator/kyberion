import { runExternalOperationSync } from '../governance/external-operation.js';
import { isDelegableExternalOperation } from '../governance/external-operation-target.js';
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
      // VCS mutations registered in the delegation registry may consult an
      // exact repository grant. Push merges and sends resolve against the
      // charter's repository+branch targets.
      delegable: isDelegableExternalOperation(operationId),
    },
    execute,
    (result) =>
      result.status === 0 && !result.error ? 'succeeded' : mutation ? 'unknown' : 'failed'
  );
}
