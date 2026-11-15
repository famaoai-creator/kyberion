import { dotDelegationCapacity } from './dot-admission-capacity.js';
import { listDotCharters, type DotCharter } from './dot-charter.js';
import type { DotDispatchDeps, DotBoundsVerdict } from './dot-dispatch.js';
import { informationWorkProposalRefusal, type DotScopedProposal } from './dot-information-work.js';
import { assertDotAccountabilityCharter } from './dot-authority.js';
import { dotMissionAdmissionRefusal } from './dot-mission-admission-bounds.js';
import {
  CONTINUOUS_MANAGED_WORK_PIPELINE,
  parseContinuousWorkPlan,
} from '../organization/continuous-work-plan.js';
import { DOT_ACTION_IDS } from './dot-proposals.js';
import { dotRoutingDecision, dotRoutingRefusal } from './dot-routing-decision.js';
import { resolveTenant } from '../organization/tenant-registry.js';
import { dotMissionAdmissionPrompt } from './dot-mission-admission-bounds.js';
import { DOT_TASK_SESSION_UNAVAILABLE_GUIDANCE, type DotExecutionShape } from './dot-proposals.js';

/** What the proposal may be at all: action, shape, handoff target. Re-checked at settlement. */
export function checkDotProposalScopeWithShapes(
  charter: DotCharter,
  proposal: DotScopedProposal,
  deps: DotDispatchDeps,
  resolveShapes: () => DotExecutionShape[]
): DotBoundsVerdict {
  try {
    assertDotAccountabilityCharter(charter, deps);
  } catch (error) {
    return { ok: false, reason: `accountability authority refused: ${String(error)}` };
  }
  const missionRefusal = dotMissionAdmissionRefusal(charter, proposal, deps.now?.());
  if (missionRefusal) return { ok: false, reason: missionRefusal };
  const informationRefusal = informationWorkProposalRefusal(charter, proposal);
  if (informationRefusal) return informationRefusal;
  if (proposal.continuous_work) {
    try {
      parseContinuousWorkPlan(proposal.continuous_work);
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
    if (
      !charter.scope.organization_id ||
      proposal.execution_shape !== 'pipeline' ||
      proposal.pipeline_ref !== CONTINUOUS_MANAGED_WORK_PIPELINE ||
      !(charter.authority.allowed_pipelines ?? []).includes(CONTINUOUS_MANAGED_WORK_PIPELINE) ||
      proposal.handoff_to ||
      proposal.front_desk_execution
    ) {
      return {
        ok: false,
        reason:
          'Continuous managed work requires an organization and the explicitly allowed owner pipeline without handoff',
      };
    }
  }
  if (!DOT_ACTION_IDS.includes(proposal.action_id)) {
    return { ok: false, reason: `action '${proposal.action_id}' is not a dot action` };
  }
  const shapes = resolveShapes();
  if (proposal.execution_shape === 'task_session' && !deps.taskSessionExecutorAvailable) {
    return { ok: false, reason: DOT_TASK_SESSION_UNAVAILABLE_GUIDANCE };
  }
  if (!shapes.includes(proposal.execution_shape)) {
    return {
      ok: false,
      reason: `execution_shape '${proposal.execution_shape}' is outside allowed_execution_shapes (${shapes.join(', ')})`,
    };
  }
  const routingDecision = dotRoutingDecision(proposal.execution_shape);
  const routingRefusal = dotRoutingRefusal(proposal.execution_shape, routingDecision);
  if (routingRefusal) return { ok: false, reason: routingRefusal };
  const tenantSlug = charter.scope.tenant_slug;
  if (tenantSlug) {
    try {
      if (deps.assertTenant) {
        deps.assertTenant(
          tenantSlug,
          charter.runtime.execution_mode === 'front_desk_diagnostic'
            ? { charter, proposal }
            : undefined
        );
      } else {
        resolveTenant(tenantSlug, { rootDir: deps.rootDir });
      }
    } catch (error) {
      return {
        ok: false,
        reason: `tenant '${tenantSlug}' cannot take work: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (proposal.handoff_to) {
    if (proposal.handoff_to === charter.dot_id) {
      return { ok: false, reason: 'a dot cannot hand work to itself' };
    }
    const target = (
      deps.listCharters?.() ??
      listDotCharters(deps.rootDir, { errors: [] }).map((loaded) => loaded.charter)
    ).find((other) => other.dot_id === proposal.handoff_to);
    if (!target || target.status !== 'active') {
      return { ok: false, reason: `handoff target '${proposal.handoff_to}' is not an active dot` };
    }
    if (!sameDotHandoffScope(charter, target)) {
      return {
        ok: false,
        reason: `cross-tenant handoff denied: '${charter.dot_id}' and '${proposal.handoff_to}' are in different tenant scopes`,
      };
    }
    if (!(target.team?.accepts_handoffs_from ?? []).includes(charter.dot_id)) {
      return {
        ok: false,
        reason: `dot '${proposal.handoff_to}' does not accept handoffs from '${charter.dot_id}'`,
      };
    }
  }
  return { ok: true, routing_decision: routingDecision };
}

/** Handoffs preserve tenant and any jointly declared organization boundary. */
export function sameDotHandoffScope(from: DotCharter, to: DotCharter): boolean {
  if (from.scope.tier !== to.scope.tier) return false;
  if ((from.scope.owner_nhi ?? '') !== (to.scope.owner_nhi ?? '')) return false;
  if ((from.scope.tenant_slug ?? '') !== (to.scope.tenant_slug ?? '')) return false;
  const fromOrg = from.scope.organization_id;
  const toOrg = to.scope.organization_id;
  return fromOrg === toOrg && from.scope.project_id === to.scope.project_id;
}

/** Prompt bounds share the same sources as dispatch enforcement. */
export function composeDotBoundsPrompt(
  charter: DotCharter,
  shapes: DotExecutionShape[],
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
      ? `Allowed execution_shape values: ${shapes.join(', ')}. Any other shape is refused.`
      : 'No execution_shape is available to you now; propose nothing and report status instead.',
    ...(shapes.includes('pipeline')
      ? [
          pipelines.length
            ? `Allowed pipeline_ref values: ${pipelines.join(', ')}.`
            : 'No pipeline is allowed by your charter; do not propose pipeline work.',
        ]
      : []),
    ...(!shapes.includes('task_session') &&
    (charter.authority.allowed_execution_shapes ?? []).includes('task_session')
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
