/**
 * Who opens an approval request, as resolved by the entry point (for the
 * terminal: `cli-operator-principal.ts`). Libraries take this as a parameter
 * instead of reading the process environment themselves.
 */
export interface ApprovalRequesterRef {
  /** Recorded as `requestedBy`: an explicit `--requested-by`, else the detected principal. */
  requestedBy: string;
  /**
   * The detected principal (agent session, else the local owner member),
   * recorded as `requestedByContext.actorId`. An explicit `--requested-by`
   * adds an identity; it never replaces this one. Defaults to `requestedBy`.
   */
  actorId?: string;
  /** Display name, for people to read; never compared. */
  displayName?: string;
}

/** `requestedByContext.actorId` for a requester (the detected principal). */
export function approvalRequesterActorId(requester: ApprovalRequesterRef): string {
  return requester.actorId?.trim() || requester.requestedBy;
}

/**
 * A requester, or a function that resolves it. Entry points pass the function
 * so the requester is resolved only when a request is actually opened (not
 * when an existing one is reused) — resolving can fail under separation of
 * duties when the terminal has no stable identity.
 */
export type ApprovalRequesterInput = ApprovalRequesterRef | (() => ApprovalRequesterRef);

export function resolveApprovalRequesterInput(input: ApprovalRequesterInput): ApprovalRequesterRef {
  return typeof input === 'function' ? input() : input;
}
