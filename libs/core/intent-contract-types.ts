import type { OrganizationWorkLoopSummary } from './work-design.js';
import type { IntentResolutionPacket, StandardIntentDefinition } from './intent-resolution.js';
import type { ReasoningLevelDecision } from './reasoning-level-policy.js';
import type { ReasoningModelRoute } from './reasoning-model-routing.js';
import type { IntentUseCaseScenario } from './intent-use-case-scenario.js';
import type { WorkflowExecutionShape } from './execution-shape.js';
import type { ActuatorExecutionBrief } from './src/types/actuator-execution-brief.js';
import type { OperatorInteractionPacket } from './src/types/operator-interaction-packet.js';

export type IntentCompilerProvider = 'codex' | 'claude' | 'gemini';
export type IntentDeliveryMode = 'one_shot' | 'managed_program';

export interface IntentContract {
  kind: 'intent-contract';
  source_text: string;
  intent_id: string;
  correlation_id?: string;
  capability_bundle_id?: string;
  execution_profile_id?: string;
  goal: { summary: string; success_condition: string };
  resolution: { execution_shape: WorkflowExecutionShape; task_type?: string };
  required_inputs: string[];
  outcome_ids: string[];
  approval: { requires_approval: boolean };
  delivery_mode: IntentDeliveryMode;
  clarification_needed: boolean;
  confidence: number;
  why: string;
}

export interface IntentDeliveryDecision {
  mode: IntentDeliveryMode;
  shouldBootstrapProject: boolean;
  shouldStartMission: boolean;
  shouldDeliverDirectOutcome: boolean;
  askHumanToConfirm: boolean;
  rationale: string;
}

export type AgentRoutingMode = 'prompt' | 'subagent' | 'coordination';
export type AgentRoutingScope =
  'single_artifact' | 'multi_artifact' | 'stateful_flow' | 'boundary_crossing';
export type AgentRoutingAutonomy = 'low' | 'medium' | 'high';
export type AgentRoutingFanout = 'none' | 'parallel' | 'review' | 'cross_critique';

export interface AgentRoutingDecision {
  kind: 'agent-routing-decision';
  source_text: string;
  intent_id: string;
  mode: AgentRoutingMode;
  scope: AgentRoutingScope;
  autonomy: AgentRoutingAutonomy;
  boundary_crossing: boolean;
  fanout: AgentRoutingFanout;
  owner: string;
  delegates?: string[];
  artifact_count: number;
  stop_condition: string;
  rationale: string;
}

export interface UserIntentFlow {
  executionBrief: ActuatorExecutionBrief;
  intentContract: IntentContract;
  workLoop: OrganizationWorkLoopSummary;
  useCaseScenario?: IntentUseCaseScenario;
  correlationId?: string;
  routingDecision?: AgentRoutingDecision;
  reasoningDecision: ReasoningLevelDecision;
  shadowModelRoute: ReasoningModelRoute;
  clarificationPacket?: OperatorInteractionPacket;
  source: 'llm' | 'fallback';
}

export interface CompileUserIntentFlowInput {
  text: string;
  correlationId?: string;
  channel?: string;
  locale?: string;
  projectId?: string;
  projectName?: string;
  trackId?: string;
  trackName?: string;
  tier?: 'personal' | 'confidential' | 'public';
  tenantId?: string;
  tenantSlug?: string;
  serviceBindings?: string[];
  runtimeContext?: Record<string, unknown>;
  resolutionPacket?: IntentResolutionPacket;
}

export interface IntentCompilerTarget {
  provider: IntentCompilerProvider;
  model?: string;
  modelProvider?: string;
}

export interface ClarificationFormatOptions {
  concise?: boolean;
  locale?: string;
}

export type { StandardIntentDefinition };
