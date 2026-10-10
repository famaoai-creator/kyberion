/**
 * Approval requesters resolved at the CLI entry point (libraries take the
 * result as a parameter instead of reading the environment). Each returns a
 * function so the requester is resolved only when a request is actually
 * opened — see `ApprovalRequesterInput`.
 */
import { getRegisteredEnvText } from '@agent/core/foundation/env';
import type { ApprovalRequesterRef } from '@agent/core/governance/approval-requester';
import { resolveCliApprovalRequester } from '@agent/core/governance/cli-operator-principal';

/** A lazily resolved terminal requester; `explicit` is `--requested-by`. */
export function cliApprovalRequester(
  explicit: string | undefined,
  legacy: string
): () => ApprovalRequesterRef {
  return () => resolveCliApprovalRequester({ explicit, legacy });
}

/** The mission controller CLI's requester (legacy default: persona, USER). */
export function missionControllerRequester(explicit?: string): () => ApprovalRequesterRef {
  return cliApprovalRequester(
    explicit,
    getRegisteredEnvText('KYBERION_PERSONA') || getRegisteredEnvText('USER') || 'mission_controller'
  );
}
