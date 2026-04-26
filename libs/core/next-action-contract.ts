export type NextActionType =
  | 'request_clarification'
  | 'approve'
  | 'inspect_evidence'
  | 'retry_delivery'
  | 'promote_mission_seed'
  | 'resume_mission';

export type NextActionRisk = 'low' | 'medium' | 'high';
export type NextActionSurfaceRoute =
  | 'approvals'
  | 'mission-seeds'
  | 'memory-promotion-queue'
  | 'next-actions';

export interface NextActionContract {
  action_id: string;
  next_action_type: NextActionType;
  reason: string;
  risk: NextActionRisk;
  suggested_command?: string;
  suggested_surface_action?: NextActionSurfaceRoute;
  approval_required: boolean;
}

const DESTRUCTIVE_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-fdx\b/i,
  /\bshutdown\b/i,
];

function isNonEmpty(value: unknown): boolean {
  return String(value || '').trim().length > 0;
}

function isPotentiallyDestructiveCommand(command?: string): boolean {
  const normalized = String(command || '').trim();
  if (!normalized) return false;
  return DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function validateNextActionContract(value: unknown): { valid: boolean; errors: string[] } {
  const candidate = value as NextActionContract;
  const errors: string[] = [];
  if (!candidate || typeof candidate !== 'object') {
    return { valid: false, errors: ['next action must be an object'] };
  }
  if (!isNonEmpty(candidate.action_id)) errors.push('action_id is required');
  if (!isNonEmpty(candidate.reason)) errors.push('reason is required');
  if (!['low', 'medium', 'high'].includes(String(candidate.risk || ''))) {
    errors.push('risk must be low|medium|high');
  }
  if (
    ![
      'request_clarification',
      'approve',
      'inspect_evidence',
      'retry_delivery',
      'promote_mission_seed',
      'resume_mission',
    ].includes(String(candidate.next_action_type || ''))
  ) {
    errors.push(
      'next_action_type must be request_clarification|approve|inspect_evidence|retry_delivery|promote_mission_seed|resume_mission',
    );
  }
  if (!isNonEmpty(candidate.suggested_command) && !isNonEmpty(candidate.suggested_surface_action)) {
    errors.push('either suggested_command or suggested_surface_action is required');
  }
  if (
    isNonEmpty(candidate.suggested_surface_action) &&
    !['approvals', 'mission-seeds', 'memory-promotion-queue', 'next-actions'].includes(String(candidate.suggested_surface_action))
  ) {
    errors.push('suggested_surface_action must be approvals|mission-seeds|memory-promotion-queue|next-actions');
  }
  if (isPotentiallyDestructiveCommand(candidate.suggested_command) && candidate.approval_required !== true) {
    errors.push('destructive suggested_command requires approval_required=true');
  }
  return { valid: errors.length === 0, errors };
}

export function createNextActionContract(input: {
  actionId: string;
  type: NextActionType;
  reason: string;
  risk: NextActionRisk;
  suggestedCommand?: string;
  suggestedSurfaceAction?: NextActionSurfaceRoute;
  approvalRequired?: boolean;
}): NextActionContract {
  return {
    action_id: input.actionId,
    next_action_type: input.type,
    reason: input.reason,
    risk: input.risk,
    suggested_command: input.suggestedCommand,
    suggested_surface_action: input.suggestedSurfaceAction,
    approval_required: Boolean(input.approvalRequired),
  };
}
