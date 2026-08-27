import type { StandardIntentDefinition } from './intent-resolution.js';
import type { OrganizationWorkLoopSummary } from './work-design.js';
import type {
  AgentRoutingAutonomy,
  AgentRoutingDecision,
  AgentRoutingFanout,
  AgentRoutingMode,
  AgentRoutingScope,
  IntentContract,
} from './intent-contract-types.js';

export interface IntentRoutingDecisionDependencies {
  resolvePolicyRoutingDecision: (
    contract: IntentContract,
    workLoop: OrganizationWorkLoopSummary
  ) => AgentRoutingDecision | null;
  findStandardIntentById: (intentId: string) => StandardIntentDefinition | undefined;
}

export function deriveAgentRoutingDecision(
  contract: IntentContract,
  workLoop: OrganizationWorkLoopSummary,
  sourceText = contract.source_text,
  dependencies: IntentRoutingDecisionDependencies
): AgentRoutingDecision {
  const policyDecision = dependencies.resolvePolicyRoutingDecision(contract, workLoop);
  if (policyDecision) return policyDecision;

  const intent = dependencies.findStandardIntentById(contract.intent_id);
  const managedProgram = contract.delivery_mode === 'managed_program';
  const durableShape =
    contract.resolution.execution_shape === 'project_bootstrap' ||
    contract.resolution.execution_shape === 'mission';
  const boundaryCrossing =
    managedProgram ||
    durableShape ||
    workLoop.runtime_design.coordination.bus === 'mission_coordination_bus' ||
    workLoop.runtime_design.memory.store === 'mission_working_memory';
  const browserSession = intent?.execution_shape === 'browser_session';
  const lowRiskSimpleIntent =
    intent?.risk_profile === 'low' &&
    contract.outcome_ids.length <= 1 &&
    contract.required_inputs.length <= 1;
  const reviewHeavy =
    workLoop.review_design.review_mode !== 'lean' ||
    contract.required_inputs.length >= 2 ||
    contract.outcome_ids.length > 1 ||
    (intent?.plan_outline?.length || 0) >= 3 ||
    intent?.risk_profile === 'review_required';

  const mode: AgentRoutingMode = boundaryCrossing
    ? 'coordination'
    : browserSession && lowRiskSimpleIntent
      ? 'prompt'
      : reviewHeavy
        ? 'subagent'
        : 'prompt';
  const scope: AgentRoutingScope = boundaryCrossing
    ? 'boundary_crossing'
    : mode === 'coordination'
      ? 'stateful_flow'
      : contract.outcome_ids.length > 1
        ? 'multi_artifact'
        : 'single_artifact';
  const autonomy: AgentRoutingAutonomy =
    mode === 'prompt' ? 'low' : mode === 'subagent' ? (reviewHeavy ? 'high' : 'medium') : 'high';
  const fanout: AgentRoutingFanout =
    mode === 'coordination'
      ? 'parallel'
      : contract.outcome_ids.length > 1
        ? 'parallel'
        : browserSession && lowRiskSimpleIntent
          ? 'none'
          : workLoop.review_design.review_mode === 'strict'
            ? 'cross_critique'
            : reviewHeavy
              ? 'review'
              : 'none';
  const owner =
    workLoop.teaming.specialist_id ||
    intent?.specialist_id ||
    workLoop.teaming.conversation_agent ||
    'intent-owner';
  const delegates = [
    workLoop.teaming.conversation_agent,
    managedProgram ? 'mission-controller' : undefined,
  ].filter((value): value is string => Boolean(value) && value !== owner);
  const artifactCount = Math.max(contract.outcome_ids.length, mode === 'coordination' ? 1 : 1);
  const stopCondition =
    mode === 'coordination'
      ? 'The governed orchestration has a durable owner, state transition, and completion checkpoint.'
      : mode === 'subagent'
        ? 'The child worker has produced a bounded result and the owner has accepted it.'
        : 'The response is ready as a single governed reply or artifact.';
  const rationale =
    mode === 'coordination'
      ? 'The request crosses a durable governance boundary and should be managed as coordinated work.'
      : mode === 'subagent'
        ? 'The request is bounded but review-heavy enough to benefit from a child worker.'
        : 'The request can finish as a single prompt without autonomous decomposition.';
  return {
    kind: 'agent-routing-decision',
    source_text: sourceText,
    intent_id: contract.intent_id,
    mode,
    scope,
    autonomy,
    boundary_crossing: boundaryCrossing,
    fanout,
    owner,
    delegates: delegates.length > 0 ? delegates : undefined,
    artifact_count: artifactCount,
    stop_condition: stopCondition,
    rationale,
  };
}

const SIMPLE_GREETING_REGEX =
  /^(こんにちは|おはよう|こんばんは|ありがとう|さようなら|バイバイ|お疲れ様|おつかれ|hello|hi|thanks|thank you|bye)[！!！？?]?$/i;

export function isSimpleGreetingText(text: string): boolean {
  return SIMPLE_GREETING_REGEX.test(text.trim());
}
