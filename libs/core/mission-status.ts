/**
 * libs/core/mission-status.ts
 * Mission Status Transition Guard
 *
 * Enforces valid state transitions in the mission lifecycle.
 */

export type MissionStatus =
  | 'planned'
  | 'active'
  | 'validating'
  | 'distilling'
  | 'completed'
  | 'paused'
  | 'failed'
  | 'archived';

const ALLOWED_TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  planned:    ['active'],
  active:     ['validating', 'distilling', 'paused', 'failed'],
  validating: ['distilling', 'active'],
  distilling: ['completed'],
  paused:     ['active'],
  failed:     ['active'],
  completed:  ['archived'],
  archived:   [],
};

/**
 * Returns true if transitioning from `current` to `target` is allowed.
 */
export function isValidTransition(current: MissionStatus, target: MissionStatus): boolean {
  return ALLOWED_TRANSITIONS[current]?.includes(target) ?? false;
}

/**
 * Transitions from `current` to `target`, throwing if the transition is invalid.
 * Returns the target status on success (useful for assignment).
 */
export function transitionStatus(current: MissionStatus, target: MissionStatus): MissionStatus {
  if (!isValidTransition(current, target)) {
    throw new Error(
      `Invalid mission status transition: ${current} → ${target}. ` +
      `Allowed from "${current}": [${ALLOWED_TRANSITIONS[current].join(', ')}]`
    );
  }
  return target;
}
