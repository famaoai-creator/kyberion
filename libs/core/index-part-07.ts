/** Generated public API barrel part. Keep exports in source order. */

export * from './nhi-actor-verification.js';
// NI-03: RFC 8693 act-chain-analog delegation chains with attenuation.

export * from './mission/delegation-chain.js';

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
} from './reasoning/reasoning-backend.js';

export { AnthropicReasoningBackend } from './provider/anthropic-reasoning-backend.js';

export { probeAnthropicApiBackendAvailability } from './provider/anthropic-api-probe.js';

export type { AnthropicReasoningBackendOptions } from './provider/anthropic-reasoning-backend.js';

export {
  getIntentExtractor,
  registerIntentExtractor,
  resetIntentExtractor,
  stubIntentExtractor,
} from './intent/intent-extractor.js';

export type { ExtractIntentInput, IntentExtractor } from './intent/intent-extractor.js';

export { AnthropicIntentExtractor } from './provider/anthropic-intent-extractor.js';

export type { AnthropicIntentExtractorOptions } from './provider/anthropic-intent-extractor.js';

export { AnthropicVoiceBridge } from './provider/anthropic-voice-bridge.js';

export type { AnthropicVoiceBridgeOptions } from './provider/anthropic-voice-bridge.js';

export {
  CodexCliReasoningBackend,
  buildCodexCliBackendFromEnv,
} from './provider/codex-cli-reasoning-backend.js';

export type { CodexCliReasoningBackendOptions } from './provider/codex-cli-reasoning-backend.js';

export { CodexCliIntentExtractor } from './provider/codex-cli-intent-extractor.js';

export type { CodexCliIntentExtractorOptions } from './provider/codex-cli-intent-extractor.js';

export { CodexCliVoiceBridge } from './provider/codex-cli-voice-bridge.js';

export type { CodexCliVoiceBridgeOptions } from './provider/codex-cli-voice-bridge.js';

export { runCodexCliQuery, buildCodexCliQueryOptionsFromEnv } from './provider/codex-cli-query.js';

export {
  OpenAiCompatibleBackend,
  buildOpenAiCompatibleBackendFromEnv,
  buildNemotronBackendFromEnv,
  probeOpenAiCompatibleBackendAvailability,
  probeNemotronBackendAvailability,
} from './provider/openai-compatible-backend.js';

export {
  GROK_API_DEFAULT_BASE_URL,
  buildGrokApiBackendFromEnv,
  probeGrokApiBackendAvailability,
  resolveGrokApiKey,
  resolveGrokApiModel,
} from './provider/grok-api-backend.js';

export type {
  OpenAiCompatibleBackendOptions,
  OpenAiCompatibleBackendAvailability,
} from './provider/openai-compatible-backend.js';

export {
  OpenRouterBackend,
  buildOpenRouterBackendFromEnv,
  probeOpenRouterBackendAvailability,
} from './provider/openrouter-backend.js';

export type { OpenRouterBackendOptions } from './provider/openrouter-backend.js';

export {
  OPENROUTER_FREE_ROUTER_MODEL,
  isOpenRouterFreeModelId,
  isOpenRouterFreePricing,
  resolveOpenRouterModelPolicy,
  validateOpenRouterModelRecord,
} from './provider/openrouter-model-policy.js';

export type {
  OpenRouterCostPolicy,
  OpenRouterModelPolicy,
  OpenRouterModelProfile,
  OpenRouterModelRecord,
} from './provider/openrouter-model-policy.js';

export { runGeminiCliQuery, buildGeminiCliBackendFromEnv } from './provider/gemini-cli-backend.js';

export {
  GeminiApiBackend,
  buildGeminiApiBackendFromEnv,
  probeGeminiApiBackendAvailability,
} from './provider/gemini-api-backend.js';

export type { GeminiApiBackendOptions } from './provider/gemini-api-backend.js';

export { GeminiCliIntentExtractor } from './provider/gemini-cli-intent-extractor.js';

export type { GeminiCliIntentExtractorOptions } from './provider/gemini-cli-intent-extractor.js';

export { GeminiCliVoiceBridge } from './provider/gemini-cli-voice-bridge.js';

export type { GeminiCliVoiceBridgeOptions } from './provider/gemini-cli-voice-bridge.js';

export type { CodexCliQueryOptions, RunCodexCliQueryParams } from './provider/codex-cli-query.js';

export {
  assertValidCodexProfileName,
  codexProfileRoot,
  resolveCodexHome,
  resolveCodexProfileName,
} from './provider/codex-profile.js';

export { ClaudeAgentReasoningBackend } from './provider/claude-agent-reasoning-backend.js';

export type { ClaudeAgentReasoningBackendOptions } from './provider/claude-agent-reasoning-backend.js';

export { ClaudeAgentIntentExtractor } from './provider/claude-agent-intent-extractor.js';

export type { ClaudeAgentIntentExtractorOptions } from './provider/claude-agent-intent-extractor.js';

export { ClaudeAgentVoiceBridge } from './provider/claude-agent-voice-bridge.js';

export type { ClaudeAgentVoiceBridgeOptions } from './provider/claude-agent-voice-bridge.js';

export { ClaudeCliBackend } from './provider/claude-cli-backend.js';

export type { ClaudeCliBackendOptions } from './provider/claude-cli-backend.js';

export { ClaudeCliIntentExtractor } from './provider/claude-cli-intent-extractor.js';

export type { ClaudeCliIntentExtractorOptions } from './provider/claude-cli-intent-extractor.js';

export { ClaudeCliVoiceBridge } from './provider/claude-cli-voice-bridge.js';

export type { ClaudeCliVoiceBridgeOptions } from './provider/claude-cli-voice-bridge.js';

export { GrokCliBackend } from './provider/grok-cli-backend.js';

export type { GrokCliBackendOptions } from './provider/grok-cli-backend.js';

export { GrokCliIntentExtractor } from './provider/grok-cli-intent-extractor.js';

export type { GrokCliIntentExtractorOptions } from './provider/grok-cli-intent-extractor.js';

export { GrokCliVoiceBridge } from './provider/grok-cli-voice-bridge.js';

export type { GrokCliVoiceBridgeOptions } from './provider/grok-cli-voice-bridge.js';

export {
  buildGrokCliOptionsFromEnv,
  buildShellGrokCliBackendFromEnv,
  probeShellGrokCliAvailability,
  runGrokCliQuery,
} from './provider/grok-cli-backend.js';

export { runClaudeAgentQuery, ClaudeAgentQueryError } from './provider/claude-agent-query.js';

export type {
  ClaudeAgentQueryParams,
  ClaudeAgentQueryResult,
} from './provider/claude-agent-query.js';

export {
  getSpeechToTextBridge,
  getSpeechToTextBridges,
  getSpeechToTextCapabilities,
  installAvailableSpeechToTextBridges,
  installFluidAudioSpeechToTextBridgeIfAvailable,
  installManagedMlxWhisperSpeechToTextBridgeIfAvailable,
  installShellSpeechToTextBridgeIfAvailable,
  installWhisperKitSpeechToTextBridgeIfAvailable,
  buildWhisperKitTranscribeArgs,
  NO_TIMESTAMP_STT_CAPABILITIES,
  registerSpeechToTextBridge,
  normalizeSpeechToTextResult,
  resetSpeechToTextBridge,
  ShellSpeechToTextBridge,
  stubSpeechToTextBridge,
} from './voice/speech-to-text-bridge.js';

export {
  discoverLocalSttBackends,
  loadLocalSttDiscoveryRegistry,
  selectPreferredLocalSttBackend,
} from './local-stt-discovery.js';

export type {
  LocalSttBackend,
  LocalSttCandidate,
  LocalSttDiscoveryOptions,
  LocalSttSource,
} from './local-stt-discovery.js';

export type {
  ShellSpeechToTextBridgeOptions,
  SpeechToTextCapabilities,
  SpeechToTextBridge,
  TranscriptSegment,
  TranscribeInput,
  TranscribeResult,
} from './voice/speech-to-text-bridge.js';

export {
  installReasoningBackends,
  installAnthropicBackendsIfAvailable,
  resetReasoningBootstrap,
  getInstalledReasoningMode,
} from './reasoning/reasoning-bootstrap.js';

export {
  loadReasoningBackendPolicy,
  normalizeReasoningBackendMode as normalizeReasoningBackendModePolicy,
  resolveReasoningBackendModeFromContext,
} from './reasoning/reasoning-backend-policy.js';

export {
  markReasoningDegraded,
  clearReasoningDegraded,
  readReasoningDegraded,
  parseReasoningDegradedMarker,
  reasoningDegradedMarkerPath,
  type ReasoningDegradedMarker,
} from './reasoning/reasoning-degradation.js';

export {
  appendReasoningFailoverEvent,
  markReasoningFailover,
  clearReasoningFailover,
  readReasoningFailover,
  parseReasoningFailoverMarker,
  reasoningFailoverEventsPath,
  reasoningFailoverMarkerPath,
  type ReasoningFailoverEvent,
  type ReasoningFailoverMarker,
} from './reasoning/reasoning-failover.js';

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
} from './reasoning/reasoning-level-policy.js';

export { resolveRuntimeModelId, type RuntimeModelRole } from './tool/runtime-model-defaults.js';

export type {
  ReasoningLevel,
  ReasoningLevelDecision,
  ReasoningLevelPolicy,
} from './reasoning/reasoning-level-policy.js';

export {
  loadModelRegistry,
  resolveReasoningModelRoute,
  resolveTaskModelHint,
  resetReasoningModelRoutingCache,
} from './reasoning/reasoning-model-routing.js';

export type {
  ModelRegistryEntry,
  ModelRegistryFile,
  ModelCompatibilityOverrides,
  ReasoningModelRoute,
  TaskModelEffort,
  TaskModelHint,
  TaskModelHintInput,
  TaskModelTier,
} from './reasoning/reasoning-model-routing.js';

export * from './reasoning/reasoning-route-resolver.js';

export * from './llm-selection-preferences.js';

export * from './reasoning/reasoning-route-doctor.js';
export * from './reasoning/reasoning-provider-readiness.js';

export * from './reasoning/reasoning-failure-taxonomy.js';

export {
  loadVoiceTaskProfileCatalog,
  resolveVoiceTaskDistillTargetKind,
  resolveVoiceTaskProfile,
} from './voice/voice-task-profile-catalog.js';

export {
  loadMediaToneStyleMapCatalog,
  resolveMediaToneStyle,
} from './media/media-tone-style-map.js';

export {
  loadMediaDrawioPolicyCatalog,
  resolveMediaDrawioBoundaryPalette,
  resolveMediaDrawioNodeSize,
} from './media/media-drawio-policy.js';

export {
  loadMediaAwsIconRuleCatalog,
  resolveMediaAwsIconCandidates,
} from './media/media-aws-icon-rules.js';

export {
  loadMediaSemanticMapCatalog,
  resolveMediaSemanticType,
  resolveProposalEvidenceIndex,
} from './media/media-semantic-map.js';
