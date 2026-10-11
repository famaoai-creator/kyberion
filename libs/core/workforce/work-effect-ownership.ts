/** Pure target ownership rules. Lease expiry and terminal item status never prove effects stopped. */
import type { WorkEffectOwnership, WorkItem } from './work-coordination-types.js';
import { WorkCoordinationError } from './work-coordination-error.js';

function splitTarget(target: string): { kind: string; value: string } {
  const index = target.indexOf(':');
  return index < 0
    ? { kind: '', value: target }
    : { kind: target.slice(0, index), value: target.slice(index + 1) };
}
const GLOB_CHARS = /[*?[{]/;
function globRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      source += '.*';
      i++;
    } else if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
const prefix = (glob: string) => {
  const match = GLOB_CHARS.exec(glob);
  return match ? glob.slice(0, match.index) : glob;
};
export function workTargetsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const left = splitTarget(a),
    right = splitTarget(b);
  if (left.kind !== right.kind || left.kind !== 'path') return false;
  const lg = GLOB_CHARS.test(left.value),
    rg = GLOB_CHARS.test(right.value);
  if (lg && globRegExp(left.value).test(right.value)) return true;
  if (rg && globRegExp(right.value).test(left.value)) return true;
  return (
    lg &&
    rg &&
    (prefix(left.value).startsWith(prefix(right.value)) ||
      prefix(right.value).startsWith(prefix(left.value)))
  );
}
export function workTargetPatternCovers(pattern: string, target: string): boolean {
  if (pattern === target) return true;
  const owned = splitTarget(pattern),
    wanted = splitTarget(target);
  return owned.kind === wanted.kind && globRegExp(owned.value).test(wanted.value);
}

export function declaredWorkTarget(item: WorkItem): string | undefined {
  const target = item.metadata?.target;
  if (target === undefined) return undefined;
  if (typeof target !== 'string' || !target.trim() || target.length > 4096) {
    throw new WorkCoordinationError(
      'validation_error',
      'invalid declared work target; operator reconciliation required'
    );
  }
  return target;
}

/** Conservatively adopt legacy targeted dot attempts, before any mutable metadata can replace them. */
export function workEffectOwnership(item: WorkItem): WorkEffectOwnership | undefined {
  if (item.effect_ownership !== undefined) {
    const hold = item.effect_ownership;
    if (!hold || typeof hold !== 'object' || Array.isArray(hold))
      throw new WorkCoordinationError(
        'validation_error',
        'invalid stored effect ownership; operator reconciliation required'
      );
    if (
      hold.state === 'settled' &&
      (!['completed', 'pre_effect', 'human_verified'].includes(hold.settlement ?? '') ||
        typeof hold.settled_at !== 'string' ||
        !Number.isFinite(Date.parse(hold.settled_at)) ||
        (hold.settlement === 'human_verified' && typeof hold.approval_request_id !== 'string'))
    )
      throw new WorkCoordinationError(
        'validation_error',
        'invalid stored effect settlement; operator reconciliation required'
      );
    if (
      typeof hold.target !== 'string' ||
      !hold.target.trim() ||
      hold.target.length > 4096 ||
      typeof hold.attempt_id !== 'string' ||
      !hold.attempt_id ||
      typeof hold.actor_id !== 'string' ||
      !hold.actor_id ||
      !['held', 'settled'].includes(hold.state) ||
      (hold.tenant_slug !== undefined && typeof hold.tenant_slug !== 'string')
    )
      throw new WorkCoordinationError(
        'validation_error',
        'invalid stored effect ownership; operator reconciliation required'
      );
    return hold;
  }
  if (typeof item.metadata?.dot_id !== 'string') return undefined;
  const target = declaredWorkTarget(item);
  if (!target) return undefined;
  const executor = item.metadata?.dot_executor as Record<string, unknown> | undefined;
  const verified =
    typeof executor?.operator_verified_at === 'string' ? executor.operator_verified_at : '';
  const attempt = item.attempts?.at(-1);
  const expired = item.attempts?.some(
    (a) => a.failure_reason === 'lease_expired' && (a.ended_at ?? a.started_at) > verified
  );
  const uncertain =
    executor?.status === 'blocked' &&
    executor.mode !== 'escalated' &&
    String(executor.completed_at ?? '') > verified;
  if (item.status !== 'in_progress' && !expired && !uncertain) return undefined;
  return {
    target,
    attempt_id: item.current_attempt_id ?? attempt?.run_id ?? `legacy:${item.item_id}`,
    actor_id: attempt?.actor_peer_id ?? `dot:${item.metadata.handoff_to ?? item.metadata.dot_id}`,
    ...(item.context?.tenant_slug ? { tenant_slug: item.context.tenant_slug } : {}),
    state: 'held',
    acquired_at: attempt?.started_at ?? item.updated_at,
  };
}

export function findHeldWorkTarget(
  items: readonly WorkItem[],
  target: string,
  tenant?: string
): WorkItem | undefined {
  return items.find((item) => {
    const hold = workEffectOwnership(item);
    return (
      hold?.state === 'held' &&
      hold.tenant_slug === tenant &&
      workTargetsOverlap(target, hold.target)
    );
  });
}

export function settledWorkEffect(
  item: WorkItem,
  settlement: 'completed' | 'pre_effect',
  at: string
): WorkEffectOwnership | undefined {
  const hold = workEffectOwnership(item);
  if (!hold || hold.state === 'settled') return hold;
  if (hold.attempt_id !== item.current_attempt_id) {
    throw new WorkCoordinationError(
      'lease_conflict',
      'effect ownership belongs to a different attempt; retained'
    );
  }
  return { ...hold, state: 'settled', settled_at: at, settlement };
}
