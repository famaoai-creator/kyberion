/** Generated public API barrel part. Keep exports in source order. */

export * from './nhi-actor-verification.js';
// NI-03: RFC 8693 act-chain-analog delegation chains with attenuation.

export * from './delegation-chain.js';

export {
  buildFailoverReasoningBackend,
  buildRoleAwareReasoningBackend,
  getReasoningBackend,
  delegateBestOf,
  delegateStructured,
  delegateTaskWithUntrustedData,
  requestPeerAdvice,
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
  getStubServedOps,
  resetStubServedOps,
  stubExplicitlyRequested,
  getLastServedReasoningMode,
  resetReasoningFailoverTracking,
  type ReasoningPromptVisibilityContext,
  type StubServedRecord,
  type LastServedReasoningMode,
} from './reasoning-backend.js';

export { AnthropicReasoningBackend } from './anthropic-reasoning-backend.js';

export { probeAnthropicApiBackendAvailability } from './anthropic-api-probe.js';

export type { AnthropicReasoningBackendOptions } from './anthropic-reasoning-backend.js';

export {
  getIntentExtractor,
  registerIntentExtractor,
  resetIntentExtractor,
  stubIntentExtractor,
} from './intent-extractor.js';

export type { ExtractIntentInput, IntentExtractor } from './intent-extractor.js';

export { AnthropicIntentExtractor } from './anthropic-intent-extractor.js';

export type { AnthropicIntentExtractorOptions } from './anthropic-intent-extractor.js';

export { AnthropicVoiceBridge } from './anthropic-voice-bridge.js';

export type { AnthropicVoiceBridgeOptions } from './anthropic-voice-bridge.js';

export {
  CodexCliReasoningBackend,
  buildCodexCliBackendFromEnv,
} from './codex-cli-reasoning-backend.js';

export type { CodexCliReasoningBackendOptions } from './codex-cli-reasoning-backend.js';

export { CodexCliIntentExtractor } from './codex-cli-intent-extractor.js';

export type { CodexCliIntentExtractorOptions } from './codex-cli-intent-extractor.js';

export { CodexCliVoiceBridge } from './codex-cli-voice-bridge.js';

export type { CodexCliVoiceBridgeOptions } from './codex-cli-voice-bridge.js';

export { runCodexCliQuery, buildCodexCliQueryOptionsFromEnv } from './codex-cli-query.js';

export {
  OpenAiCompatibleBackend,
  buildOpenAiCompatibleBackendFromEnv,
  buildNemotronBackendFromEnv,
  probeOpenAiCompatibleBackendAvailability,
  probeNemotronBackendAvailability,
} from './openai-compatible-backend.js';

export {
  GROK_API_DEFAULT_BASE_URL,
  GROK_API_DEFAULT_MODEL,
  buildGrokApiBackendFromEnv,
  probeGrokApiBackendAvailability,
  resolveGrokApiKey,
  resolveGrokApiModel,
} from './grok-api-backend.js';

export type {
  OpenAiCompatibleBackendOptions,
  OpenAiCompatibleBackendAvailability,
} from './openai-compatible-backend.js';

export {
  OpenRouterBackend,
  buildOpenRouterBackendFromEnv,
  probeOpenRouterBackendAvailability,
} from './openrouter-backend.js';

export type { OpenRouterBackendOptions } from './openrouter-backend.js';

export {
  OPENROUTER_FREE_ROUTER_MODEL,
  isOpenRouterFreeModelId,
  isOpenRouterFreePricing,
  resolveOpenRouterModelPolicy,
  validateOpenRouterModelRecord,
} from './openrouter-model-policy.js';

export type {
  OpenRouterCostPolicy,
  OpenRouterModelPolicy,
  OpenRouterModelProfile,
  OpenRouterModelRecord,
} from './openrouter-model-policy.js';

export { runGeminiCliQuery, buildGeminiCliBackendFromEnv } from './gemini-cli-backend.js';

export {
  GeminiApiBackend,
  buildGeminiApiBackendFromEnv,
  probeGeminiApiBackendAvailability,
} from './gemini-api-backend.js';

export type { GeminiApiBackendOptions } from './gemini-api-backend.js';

export { GeminiCliIntentExtractor } from './gemini-cli-intent-extractor.js';

export type { GeminiCliIntentExtractorOptions } from './gemini-cli-intent-extractor.js';

export { GeminiCliVoiceBridge } from './gemini-cli-voice-bridge.js';

export type { GeminiCliVoiceBridgeOptions } from './gemini-cli-voice-bridge.js';

export type { CodexCliQueryOptions, RunCodexCliQueryParams } from './codex-cli-query.js';

export { ClaudeAgentReasoningBackend } from './claude-agent-reasoning-backend.js';

export type { ClaudeAgentReasoningBackendOptions } from './claude-agent-reasoning-backend.js';

export { ClaudeAgentIntentExtractor } from './claude-agent-intent-extractor.js';

export type { ClaudeAgentIntentExtractorOptions } from './claude-agent-intent-extractor.js';

export { ClaudeAgentVoiceBridge } from './claude-agent-voice-bridge.js';

export type { ClaudeAgentVoiceBridgeOptions } from './claude-agent-voice-bridge.js';

export { ClaudeCliBackend } from './claude-cli-backend.js';

export type { ClaudeCliBackendOptions } from './claude-cli-backend.js';

export { ClaudeCliIntentExtractor } from './claude-cli-intent-extractor.js';

export type { ClaudeCliIntentExtractorOptions } from './claude-cli-intent-extractor.js';

export { ClaudeCliVoiceBridge } from './claude-cli-voice-bridge.js';

export type { ClaudeCliVoiceBridgeOptions } from './claude-cli-voice-bridge.js';

export { GrokCliBackend } from './grok-cli-backend.js';

export type { GrokCliBackendOptions } from './grok-cli-backend.js';

export { GrokCliIntentExtractor } from './grok-cli-intent-extractor.js';

export type { GrokCliIntentExtractorOptions } from './grok-cli-intent-extractor.js';

export { GrokCliVoiceBridge } from './grok-cli-voice-bridge.js';

export type { GrokCliVoiceBridgeOptions } from './grok-cli-voice-bridge.js';

export {
  buildGrokCliOptionsFromEnv,
  buildShellGrokCliBackendFromEnv,
  probeShellGrokCliAvailability,
  runGrokCliQuery,
} from './grok-cli-backend.js';

export { runClaudeAgentQuery, ClaudeAgentQueryError } from './claude-agent-query.js';

export type { ClaudeAgentQueryParams, ClaudeAgentQueryResult } from './claude-agent-query.js';

export {
  getSpeechToTextBridge,
  getSpeechToTextBridges,
  getSpeechToTextCapabilities,
  installFluidAudioSpeechToTextBridgeIfAvailable,
  installManagedMlxWhisperSpeechToTextBridgeIfAvailable,
  installShellSpeechToTextBridgeIfAvailable,
  NO_TIMESTAMP_STT_CAPABILITIES,
  registerSpeechToTextBridge,
  normalizeSpeechToTextResult,
  resetSpeechToTextBridge,
  ShellSpeechToTextBridge,
  stubSpeechToTextBridge,
} from './speech-to-text-bridge.js';

export type {
  ShellSpeechToTextBridgeOptions,
  SpeechToTextCapabilities,
  SpeechToTextBridge,
  TranscriptSegment,
  TranscribeInput,
  TranscribeResult,
} from './speech-to-text-bridge.js';

export {
  installReasoningBackends,
  installAnthropicBackendsIfAvailable,
  resetReasoningBootstrap,
  getInstalledReasoningMode,
} from './reasoning-bootstrap.js';

export {
  loadReasoningBackendPolicy,
  normalizeReasoningBackendMode as normalizeReasoningBackendModePolicy,
  resolveReasoningBackendModeFromContext,
} from './reasoning-backend-policy.js';

export {
  markReasoningDegraded,
  clearReasoningDegraded,
  readReasoningDegraded,
  reasoningDegradedMarkerPath,
  type ReasoningDegradedMarker,
} from './reasoning-degradation.js';

export {
  appendReasoningFailoverEvent,
  markReasoningFailover,
  clearReasoningFailover,
  readReasoningFailover,
  reasoningFailoverEventsPath,
  reasoningFailoverMarkerPath,
  type ReasoningFailoverEvent,
  type ReasoningFailoverMarker,
} from './reasoning-failover.js';

export {
  recordAdhocPipelineRun,
  listPromotionCandidates,
  PROMOTION_CANDIDATE_MIN_RUNS,
  type AdhocRunTally,
} from './promotion-candidates.js';

export {
  appendSemanticDegradationRun,
  summarizeSemanticDegradations,
  type SemanticDegradationRun,
  type SemanticDegradationSummary,
} from './semantic-degradation-log.js';

export {
  REJECTION_REASON_CATEGORIES,
  normalizeRejectionReasonCategory,
  type RejectionReasonCategory,
} from './rejection-reason.js';

export {
  enqueueReviewReentryRequest,
  listReviewReentryRequests,
  listPendingReviewReentryRequests,
  markReviewReentryProcessed,
  buildReviewGapText,
  type ReviewReentryRequest,
  type ReviewReentryVerdict,
} from './review-reentry.js';

export {
  loadReasoningLevelPolicy,
  resolveReasoningLevelDecision,
  resetReasoningLevelPolicyCache,
  validateReasoningLevelPolicy,
} from './reasoning-level-policy.js';

export { resolveRuntimeModelId, type RuntimeModelRole } from './runtime-model-defaults.js';

export type {
  ReasoningLevel,
  ReasoningLevelDecision,
  ReasoningLevelPolicy,
} from './reasoning-level-policy.js';

export {
  loadModelRegistry,
  resolveReasoningModelRoute,
  resolveTaskModelHint,
  resetReasoningModelRoutingCache,
} from './reasoning-model-routing.js';

export type {
  ModelRegistryEntry,
  ModelRegistryFile,
  ModelCompatibilityOverrides,
  ReasoningModelRoute,
  TaskModelEffort,
  TaskModelHint,
  TaskModelHintInput,
  TaskModelTier,
} from './reasoning-model-routing.js';

export * from './reasoning-route-resolver.js';

export * from './llm-selection-preferences.js';

export * from './reasoning-route-doctor.js';

export * from './reasoning-failure-taxonomy.js';

export {
  loadVoiceTaskProfileCatalog,
  resolveVoiceTaskDistillTargetKind,
  resolveVoiceTaskProfile,
} from './voice-task-profile-catalog.js';

export { loadMediaToneStyleMapCatalog, resolveMediaToneStyle } from './media-tone-style-map.js';

export {
  loadMediaDrawioPolicyCatalog,
  resolveMediaDrawioBoundaryPalette,
  resolveMediaDrawioNodeSize,
} from './media-drawio-policy.js';

export {
  loadMediaAwsIconRuleCatalog,
  resolveMediaAwsIconCandidates,
} from './media-aws-icon-rules.js';

export {
  loadMediaSemanticMapCatalog,
  resolveMediaSemanticType,
  resolveProposalEvidenceIndex,
} from './media-semantic-map.js';
