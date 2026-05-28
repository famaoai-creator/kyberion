/**
 * libs/core/gate-status.ts
 * Gate Status Transition Guard
 *
 * Enforces valid state transitions for gate lifecycle review packets.
 */

export type GateStatus =
  | 'draft'
  | 'open'
  | 'reviewing'
  | 'approved'
  | 'blocked'
  | 'waived'
  | 'closed';

const ALLOWED_TRANSITIONS: Record<GateStatus, readonly GateStatus[]> = {
  draft: ['open'],
  open: ['reviewing', 'approved', 'blocked', 'waived'],
  reviewing: ['approved', 'blocked', 'waived', 'open'],
  approved: ['closed'],
  blocked: ['reviewing', 'open'],
  waived: ['closed'],
  closed: [],
};

export function isValidGateTransition(current: GateStatus, target: GateStatus): boolean {
  return ALLOWED_TRANSITIONS[current]?.includes(target) ?? false;
}

export function transitionGateStatus(current: GateStatus, target: GateStatus): GateStatus {
  if (!isValidGateTransition(current, target)) {
    throw new Error(
      `Invalid gate status transition: ${current} → ${target}. ` +
        `Allowed from "${current}": [${ALLOWED_TRANSITIONS[current].join(', ')}]`
    );
  }
  return target;
}
