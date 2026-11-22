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
 * Steps with unknown deps land in layer 0 after roots.
 */
export function computePlanLayers(
  steps: ReadonlyArray<{ id: string; depends_on?: string[] }>
): PlanLayer[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const depth = new Map<string, number>();

  function depthOf(id: string, stack: Set<string>): number {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (stack.has(id)) return 0;
    stack.add(id);
    const step = byId.get(id);
    const deps = (step?.depends_on ?? []).filter((dep) => byId.has(dep));
    const value = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => depthOf(dep, stack))) + 1;
    stack.delete(id);
    depth.set(id, value);
    return value;
  }

  for (const step of steps) depthOf(step.id, new Set());

  const max = steps.reduce((acc, step) => Math.max(acc, depth.get(step.id) ?? 0), 0);
  const layers: PlanLayer[] = [];
  for (let index = 0; index <= max; index += 1) {
    const stepIds = steps.filter((step) => (depth.get(step.id) ?? 0) === index).map((s) => s.id);
    if (stepIds.length) layers.push({ index, stepIds });
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
  const clarify = Boolean(
    preview.delivery.clarificationNeeded || preview.delivery.askHumanToConfirm || missing.length
  );

  const next_actions: NonNullable<OperatorInteractionPacket['next_actions']> = [
    {
      id: 'plan-start',
      action: 'Start',
      next_action_type: 'start_mission',
      priority: 'now',
      reason: preview.delivery.rationale || preview.goal.successCondition,
    },
    {
      id: 'plan-modify',
      action: 'Modify',
      next_action_type: 'clarify',
      priority: 'next',
      reason: 'Request changes; previous approval must not be reused after brief rehash',
    },
  ];

  if (clarify) {
    next_actions.unshift({
      id: 'plan-inspect',
      action: 'Inspect missing inputs',
      next_action_type: 'inspect',
      priority: 'now',
      reason: missing.join(', ') || 'clarification needed',
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
