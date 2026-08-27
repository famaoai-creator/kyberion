import type { ReasoningLevelDecision } from './reasoning-level-policy.js';
import type { ReasoningModelRoute } from './reasoning-model-routing.js';
import type { TraceContext } from './src/trace.js';

export interface IntentCompilationEventInput {
  reasoningDecision: ReasoningLevelDecision;
  shadowModelRoute: ReasoningModelRoute;
  source: 'llm' | 'fallback';
  cacheStatus: 'disabled' | 'miss' | 'hit' | 'invalid' | 'write';
  selectedIntentId?: string;
  selectedConfidence?: number;
  compilerProvider: string;
  compilerModel: string;
  fallbackReason: string;
  reasoningPolicyVersion: string;
  selectedResolutionShape?: string;
  contractExecutionShape?: string;
  declaredModelTier?: 'fast' | 'standard' | 'deep';
}

export function emitIntentCompilationCompletedEvent(
  trace: Pick<TraceContext, 'addEvent'> | undefined,
  input: IntentCompilationEventInput
): void {
  const shapeDisagreement =
    Boolean(input.selectedResolutionShape) &&
    Boolean(input.contractExecutionShape) &&
    input.selectedResolutionShape !== input.contractExecutionShape;
  trace?.addEvent('intent_compilation.completed', {
    reasoning_level: input.reasoningDecision.level,
    reasoning_rule_id: input.reasoningDecision.rule_id,
    source: input.source,
    selected_intent_id: input.selectedIntentId || '',
    selected_confidence: input.selectedConfidence ?? 0,
    compiler_provider: input.compilerProvider,
    compiler_model: input.compilerModel,
    recommended_model_id: input.shadowModelRoute.recommended_model_id || '',
    model_route_status: input.shadowModelRoute.model_route_status,
    cache_status: input.cacheStatus,
    fallback_reason: input.fallbackReason,
    reasoning_policy_version: input.reasoningPolicyVersion,
    shape_disagreement: shapeDisagreement,
    selected_resolution_shape: input.selectedResolutionShape || '',
    contract_execution_shape: input.contractExecutionShape || '',
    declared_model_tier: input.declaredModelTier || '',
  });
}
