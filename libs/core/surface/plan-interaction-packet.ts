/**
 * Plan Interaction Card — Operator Interaction Packet over plan-preview.
 *
 * Bundles the existing ops plan-preview read-model into an
 * `execution-preview` packet so conversation / Needs You can Start or Modify
 * without calling mission_controller from the browser.
 *
 * @see knowledge/product/architecture/pibot-absorption-model.md
 */

import type { OperatorInteractionPacket } from '../contracts/operator-interaction-packet.js';

/** Minimal plan-preview shape shared with Concierge `PlanPreviewResponse`. */
export interface PlanPreviewLike {
  missionId: string;
  requestText: string;
  confidence?: number;
  goal: { summary: string; successCondition: string };
  delivery: {
    mode: string;
    requiresApproval: boolean;
    clarificationNeeded: boolean;
    askHumanToConfirm: boolean;
    rationale: string;
  };
  execution: {
    shape: string;
    taskType?: string;
    requiredInputs: string[];
    missingInputs: string[];
    clarificationQuestions?: Array<{
      id: string;
      question: string;
      reason: string;
      default_assumption?: string;
      impact?: string;
    }>;
    recommendedNextStep?: string;
  };
  workflow: Array<{
    id: string;
    label: string;
    description: string;
    actuator: string;
    phase: string;
    requires_confirmation?: boolean;
    depends_on?: string[];
    input_refs?: string[];
    output_refs?: string[];
  }>;
  team?: {
    orgRole?: string;
    members?: Array<{ role?: string; peerId?: string; label?: string }>;
  };
}

export interface PlanLayer {
  index: number;
  stepIds: string[];
}

/**
 * Deterministic DAG layers from `depends_on` (PiBot GroupPlanCard shape).
 * An incomplete or cyclic dependency graph has no valid layers.
 */
export function computePlanLayers(
  steps: ReadonlyArray<{ id: string; depends_on?: string[] }>
): PlanLayer[] {
  const remaining = new Map(steps.map((step) => [step.id, 0]));
  if (remaining.size !== steps.length) return [];
  const dependents = new Map<string, string[]>();
  const queue: string[] = [];
  for (const { id, depends_on } of steps) {
    const dependencies = new Set(depends_on ?? []);
    remaining.set(id, dependencies.size);
    if (!dependencies.size) queue.push(id);
    for (const dependency of dependencies) {
      if (!remaining.has(dependency)) return [];
      const linked = dependents.get(dependency) ?? [];
      linked.push(id);
      dependents.set(dependency, linked);
    }
  }
  const depth = new Map<string, number>();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor]!;
    for (const dependent of dependents.get(id) ?? []) {
      depth.set(dependent, Math.max(depth.get(dependent) ?? 0, (depth.get(id) ?? 0) + 1));
      const count = remaining.get(dependent)! - 1;
      remaining.set(dependent, count);
      if (count === 0) queue.push(dependent);
    }
  }
  if (queue.length !== steps.length) return [];
  const layers: PlanLayer[] = [];
  for (const step of steps) {
    const index = depth.get(step.id) ?? 0;
    (layers[index] ??= { index, stepIds: [] }).stepIds.push(step.id);
  }
  return layers;
}

export interface PlanInteractionPacketExtras {
  layers: PlanLayer[];
  owners: string[];
  deliverables: string[];
  estimate: { steps: number; requires_approval: boolean };
}

/**
 * Adapt plan-preview → Operator Interaction Packet (`execution-preview`).
 * Start = start_mission; Modify = clarify (changeRequest / brief rehash).
 */
export function buildPlanInteractionPacket(
  preview: PlanPreviewLike
): OperatorInteractionPacket & { plan: PlanInteractionPacketExtras } {
  const layers = computePlanLayers(preview.workflow);
  const owners = (preview.team?.members ?? [])
    .map((member) => member.label || member.role || member.peerId || '')
    .filter(Boolean);
  if (preview.team?.orgRole && !owners.includes(preview.team.orgRole)) {
    owners.unshift(preview.team.orgRole);
  }
  const deliverables = preview.workflow.flatMap((step) => step.output_refs ?? []);
  const missing = preview.execution.missingInputs ?? [];
  const invalidGraph = preview.workflow.length > 0 && layers.length === 0;
  const clarify = preview.delivery.clarificationNeeded || missing.length > 0 || invalidGraph;

  const next_actions: NonNullable<OperatorInteractionPacket['next_actions']> = [
    {
      id: 'plan-modify',
      action: 'Modify',
      next_action_type: 'clarify',
      priority: 'next',
      reason: 'Request changes and review the revised plan',
    },
  ];

  if (clarify) {
    next_actions.unshift({
      id: 'plan-inspect',
      action: invalidGraph ? 'Inspect plan dependencies' : 'Inspect missing inputs',
      next_action_type: 'inspect',
      priority: 'now',
      reason: invalidGraph
        ? 'The workflow has invalid dependencies'
        : missing.join(', ') || 'Clarification needed',
    });
  } else {
    next_actions.unshift({
      id: 'plan-start',
      action: preview.delivery.askHumanToConfirm ? 'Review and start' : 'Start',
      next_action_type: 'start_mission',
      priority: 'now',
      reason: preview.delivery.rationale || preview.goal.successCondition,
    });
  }

  const packet: OperatorInteractionPacket & { plan: PlanInteractionPacketExtras } = {
    kind: 'operator-interaction-packet',
    interaction_type: 'execution-preview',
    headline: preview.goal.summary || `Plan for ${preview.missionId}`,
    summary: preview.requestText,
    readiness: clarify ? 'needs_clarification' : 'ready',
    confidence: preview.confidence,
    missing_inputs: missing,
    questions: preview.execution.clarificationQuestions,
    next_actions,
    suggested_response_style: clarify ? 'clarify-first' : 'preview-and-confirm',
    plan: {
      layers,
      owners,
      deliverables,
      estimate: {
        steps: preview.workflow.length,
        requires_approval: preview.delivery.requiresApproval,
      },
    },
  };

  return packet;
}

/**
 * Map a Plan card next_action to the governed Start / Modify path.
 * Start must go through approval-store admission (`approvePlanAndStart`), never
 * a browser `mission_controller start`. Modify is a changeRequest / brief rehash.
 */
export function resolvePlanInteractionAction(
  actionId: string
): 'start_mission' | 'modify_plan' | 'inspect' | null {
  switch (actionId) {
    case 'plan-start':
      return 'start_mission';
    case 'plan-modify':
      return 'modify_plan';
    case 'plan-inspect':
      return 'inspect';
    default:
      return null;
  }
}
