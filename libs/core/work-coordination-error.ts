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
