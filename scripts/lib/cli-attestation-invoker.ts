/**
 * The attestation invoker as the terminal captures it: who asked (persona and
 * tenant binding, before any role elevation) plus the approval requester the
 * terminal resolves (`cli-operator-principal.ts`). Resolution happens here, in
 * the CLI entry point, so `tenant-governance.ts` never reads the environment
 * for it.
 */
import {
  captureAttestationInvoker,
  type AttestationInvoker,
} from '@agent/core/organization/tenant-governance';
import { resolveCliApprovalRequester } from '@agent/core/governance/cli-operator-principal';

export function captureCliAttestationInvoker(): AttestationInvoker {
  const invoker = captureAttestationInvoker();
  try {
    return {
      ...invoker,
      approvalRequester: resolveCliApprovalRequester({ legacy: invoker.actor }),
    };
  } catch (error) {
    // Reported only when a request is actually opened (separation of duties on).
    return {
      ...invoker,
      approvalRequesterError: error instanceof Error ? error.message : String(error),
    };
  }
}
