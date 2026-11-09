import { describe, expect, it } from 'vitest';
import {
  EXECUTION_SHAPE_VALUES,
  normalizeExecutionShape,
  projectExecutionShapeToWorkflowShape,
  type ExecutionShape,
} from '../contracts/execution-shape.js';
import { resolveWorkScopeDecision } from '../workforce/work-scope-decision.js';
import type { OrganizationWorkLoopSummary } from '../workforce/work-design.js';
import {
  deriveAgentRoutingDecision,
  deriveIntentDeliveryDecision,
  inferGovernedDeliveryMode,
} from './intent-contract.js';
import type { IntentContract, IntentDeliveryMode } from './intent-contract-types.js';
import { loadStandardIntentCatalog } from './intent-resolution.js';
import expected from './promotion-judgment-characterization.fixture.json';

/*
 * Characterization of the mission-promotion judgment (R2 of the intent resolver
 * unification plan). Three places used to decide "is this shape durable?" on
 * their own: intent-routing-decision.ts, intent-delivery-decision.ts and the
 * intent-policy.json `durable-shapes` rule. R2 moves the judgment into
 * work-scope-policy.json; this table was recorded before that move and must
 * stay identical after it, across every standard intent.
 */

const LEAN_WORK_LOOP = {
  intent: { label: 'characterization' },
  context: { tier: 'public', service_bindings: [] },
  resolution: { execution_shape: 'task_session' },
  workflow_design: {
    workflow_id: 'single-track-default',
    pattern: 'single_track_execution',
    stage: 'planning',
    phases: ['intake', 'planning', 'execution'],
    rationale: 'Default workflow.',
  },
  review_design: {
    review_mode: 'lean',
    required_gate_ids: [],
    all_gate_ids: [],
    rationale: 'Lean review.',
  },
  outcome_design: { outcome_ids: [], labels: [] },
  process_design: { plan_outline: [], intake_requirements: [], operator_checklist: [] },
  runtime_design: {
    owner_model: 'single_actor',
    assignment_policy: 'direct_specialist',
    coordination: { bus: 'none', channels: [] },
    memory: { store: 'none', scope: 'none', purpose: [] },
  },
  execution_boundary: {
    llm_zone: { allowed: [], forbidden: [] },
    knowledge_zone: { owns: [] },
    compiler_zone: { responsibilities: [] },
    executor_zone: { responsibilities: [] },
    rule: 'bounded',
  },
  teaming: { team_roles: [] },
  authority: { requires_approval: false },
  learning: { reusable_refs: [] },
} as unknown as OrganizationWorkLoopSummary;

function contractFor(
  intentId: string,
  shape: ExecutionShape,
  deliveryMode: IntentDeliveryMode,
  clarificationNeeded: boolean
): IntentContract {
  return {
    kind: 'intent-contract',
    source_text: intentId,
    intent_id: intentId,
    goal: { summary: intentId, success_condition: 'characterized' },
    resolution: { execution_shape: projectExecutionShapeToWorkflowShape(shape) },
    required_inputs: [],
    outcome_ids: [],
    approval: { requires_approval: false },
    delivery_mode: deliveryMode,
    clarification_needed: clarificationNeeded,
    confidence: 1,
    why: 'characterization',
  } as IntentContract;
}

function characterize(intentId: string, shape: ExecutionShape): string {
  const workScope = resolveWorkScopeDecision({ catalogMinimumShape: shape });
  const parts = [
    `shape=${shape}`,
    `scope=${workScope.promotion_required ? 'promote' : 'keep'}:${workScope.execution_shape}:${workScope.matched_rule_ids.join('+')}`,
    `delivery=${inferGovernedDeliveryMode('', shape, [])}`,
  ];
  for (const deliveryMode of ['one_shot', 'managed_program'] as const) {
    for (const clarificationNeeded of [false, true]) {
      const contract = contractFor(intentId, shape, deliveryMode, clarificationNeeded);
      const delivery = deriveIntentDeliveryDecision(contract);
      const routing = deriveAgentRoutingDecision(contract, LEAN_WORK_LOOP);
      parts.push(
        [
          `${deliveryMode}${clarificationNeeded ? '?' : ''}`,
          `boot=${delivery.shouldBootstrapProject}`,
          `mission=${delivery.shouldStartMission}`,
          `direct=${delivery.shouldDeliverDirectOutcome}`,
          `confirm=${delivery.askHumanToConfirm}`,
          `route=${routing.mode}/${routing.scope}/${routing.boundary_crossing}`,
        ].join(',')
      );
    }
  }
  return parts.join(' | ');
}

function buildTable(): Record<string, string> {
  const table: Record<string, string> = {};
  // Every shape, independent of whether a catalog intent declares it today.
  for (const shape of EXECUTION_SHAPE_VALUES) {
    table[`__shape:${shape}`] = characterize('characterization-probe', shape);
  }
  for (const intent of loadStandardIntentCatalog()) {
    const id = String(intent.id || '');
    if (!id) continue;
    const shape = normalizeExecutionShape(
      (intent as { execution_shape?: string }).execution_shape || intent.resolution?.shape
    );
    table[id] = characterize(id, shape);
  }
  return table;
}

describe('mission-promotion judgment characterization (R2)', () => {
  it('keeps delivery, routing, delivery-mode and work-scope outcomes for every standard intent', () => {
    expect(buildTable()).toEqual(expected);
  });
});
