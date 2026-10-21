import { dotDelegationCapacity } from './dot-admission-capacity.js';
import { listDotCharters, type DotCharter } from './dot-charter.js';
import type { DotDispatchDeps } from './dot-dispatch.js';
import { dotMissionAdmissionPrompt } from './dot-mission-admission-bounds.js';
import { DOT_TASK_SESSION_UNAVAILABLE_GUIDANCE, type DotWorkShape } from './dot-proposals.js';

/** Handoffs preserve tenant and any jointly declared organization boundary. */
export function sameDotHandoffScope(from: DotCharter, to: DotCharter): boolean {
  if ((from.scope.tenant_slug ?? '') !== (to.scope.tenant_slug ?? '')) return false;
  const fromOrg = from.scope.organization_id;
  const toOrg = to.scope.organization_id;
  return !fromOrg || !toOrg || fromOrg === toOrg;
}

/** Prompt bounds share the same sources as dispatch enforcement. */
export function composeDotBoundsPrompt(
  charter: DotCharter,
  shapes: DotWorkShape[],
  deps: DotDispatchDeps
): string[] {
  const pipelines = charter.authority.allowed_pipelines ?? [];
  const { cap, free } = dotDelegationCapacity(charter, deps);
  const partners = (
    deps.listCharters?.() ??
    listDotCharters(deps.rootDir, { errors: [] }).map((loaded) => loaded.charter)
  )
    .filter(
      (other) =>
        other.dot_id !== charter.dot_id &&
        other.status === 'active' &&
        sameDotHandoffScope(charter, other) &&
        (other.team?.accepts_handoffs_from ?? []).includes(charter.dot_id)
    )
    .map((other) => other.dot_id);
  return [
    ...dotMissionAdmissionPrompt(charter, shapes, deps.now?.() ?? new Date()),
    shapes.length
      ? `Allowed work_shape values: ${shapes.join(', ')}. Any other shape is refused.`
      : 'No work_shape is available to you now; propose nothing and report status instead.',
    ...(shapes.includes('pipeline')
      ? [
          pipelines.length
            ? `Allowed pipeline_ref values: ${pipelines.join(', ')}.`
            : 'No pipeline is allowed by your charter; do not propose pipeline work.',
        ]
      : []),
    ...(!shapes.includes('task_session') &&
    (charter.authority.allowed_work_shapes ?? []).includes('task_session')
      ? [DOT_TASK_SESSION_UNAVAILABLE_GUIDANCE]
      : []),
    free > 0
      ? `Delegation slots free: ${free} of ${cap}. Propose at most ${free}, most important first; valid extra proposals wait for capacity.`
      : `Delegation slots free: 0 of ${cap} (open work or decisions waiting on the operator). Propose nothing new; report status instead.`,
    partners.length
      ? `Dots that accept your handoffs (handoff_to): ${partners.join(', ')}.`
      : 'No dot accepts handoffs from you; do not use handoff_to.',
  ];
}
