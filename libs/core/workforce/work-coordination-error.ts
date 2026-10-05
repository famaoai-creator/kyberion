import { getOperationsHaltState } from '../governance/operations-halt.js';

export interface WorkCoordinationErrorDetails {
  [key: string]: unknown;
}

export class WorkCoordinationError extends Error {
  constructor(
    public readonly code:
      | 'item_not_found'
      | 'board_not_found'
      | 'lease_conflict'
      | 'lease_not_found'
      | 'version_conflict'
      | 'validation_error'
      | 'idempotency_conflict'
      | 'board_conflict',
    message: string,
    public readonly details: WorkCoordinationErrorDetails = {}
  ) {
    super(message);
    this.name = 'WorkCoordinationError';
  }
}

/**
 * P1-9: a write claim is how an agent gains the right to change anything, so a
 * halted system hands out no new ones (existing leases are left to expire).
 */
export function assertWorkClaimsAllowed(itemId: string): void {
  const halt = getOperationsHaltState();
  if (!halt.halted) return;
  throw new WorkCoordinationError(
    'validation_error',
    `operations are halted${halt.by ? ` by ${halt.by}` : ''} — no new work claims | next: pnpm kyberion halt resume`,
    { item_id: itemId }
  );
}
