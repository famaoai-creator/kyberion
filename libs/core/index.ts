/**
 * @agent/core - Unified Entry Point
 * All shared utilities and wrappers are centralized here.
 * [STABLE RECONSTRUCTION VERSION 2]
 */

// Core Foundation (logger, ui, sre, Cache, fileUtils, errorHandler)
export * from './core.js';

// Specific Wrappers & Metrics
export * from './skill-wrapper.js';
export * from './capability-wrapper.js';
export * from './metrics.js';
export * from './error-codes.js';

// Secure IO & Filesystem (Shield Layer)
export * as secureIo from './secure-io.js';
export { 
  safeReadFile, 
  safeWriteFile, 
  safeAppendFileSync, 
  safeCopyFileSync,
  safeMoveSync,
  safeSymlinkSync,
  safeRmSync,
  safeUnlinkSync, 
  safeMkdir, 
  safeExistsSync, 
  safeExec,
  buildSafeExecEnv,
  safeReaddir,
  safeStat,
  safeLstat,
  safeReadlink,
  safeOpenAppendFile,
  safeFsyncFile
} from './secure-io.js';

// Backward compatibility aliases
export { 
  safeAppendFileSync as safeAppendFile,
  safeUnlinkSync as safeUnlink
} from './secure-io.js';

// Paths & Navigation
export * as pathResolver from './path-resolver.js';
export { 
  rootDir, 
  knowledge, 
  scripts, 
  active, 
  vault, 
  capabilityAssets,
  shared,
  sharedTmp,
  sharedExports,
  isProtected, 
  capabilityEntry,
  capabilityDir,
  skillDir, 
  missionDir,
  missionEvidenceDir,
  findMissionPath,
  resolve,
  rootResolve
} from './path-resolver.js';

// Utils
export * from './fs-utils.js';
export * from './cli-utils.js';
export * from './ledger.js';
export * from './src/logic-utils.js';
export * from './src/lock-utils.js';
export * from './src/retry-utils.js';
export { parseData, stringifyData } from './data-utils.js'; // Explicitly avoid detectFormat conflict
export * from './detectors.js';
export * from './validators.js';
export * from './mobile-profile-validators.js';
export * from './schema-loader.js';

// Classification & Knowledge
export * as classifier from './classifier.js';
export * from './knowledge-provider.js';
export { buildKnowledgeIndex, queryKnowledge, KnowledgeHintIndex } from './src/knowledge-index.js';
export type { KnowledgeHint, KnowledgeQueryOptions } from './src/knowledge-index.js';

// Networking
export { secureFetch } from './network.js';
export { distillPdfDesign } from './src/pdf-utils.js';
export { distillPptxDesign } from './src/pptx-utils.js';
export { distillXlsxDesign } from './src/xlsx-utils.js';
export { distillDocxDesign } from './src/docx-utils.js';
export { generateNativePdf } from './src/native-pdf-engine/engine.js';
export { generateNativePptx, patchPptxText } from './src/native-pptx-engine/engine.js';
export { generateNativeXlsx } from './src/native-xlsx-engine/engine.js';
export { generateNativeDocx } from './src/native-docx-engine/engine.js';
export { protocolToMarkdown, pdfToMarkdown, docxToMarkdown, xlsxToMarkdown, pptxToMarkdown, extractTablesFromPage } from './src/protocol-to-markdown.js';
export type {
  XlsxCell,
  XlsxCellStyle,
  XlsxColor,
  XlsxConditionalFormat,
  XlsxDataValidation,
  XlsxDesignProtocol,
  XlsxDxfStyle,
  XlsxMergeCell,
  XlsxWorksheet,
} from './src/types/xlsx-protocol.js';
export type { PdfDesignProtocol, PdfAesthetic, PdfLayoutElement, PdfPage } from './src/types/pdf-protocol.js';

// Document Design Protocol (Generic Base)
export type {
  DocumentDesignProtocol,
  DocumentProvenance,
  TransformStep,
  DesignDelta,
  SemanticOf,
} from './src/types/document-protocol.js';
export {
  diffDesign,
  wrapAsPptxDocument,
  wrapAsXlsxDocument,
} from './src/types/document-protocol.js';

// Evidence Chain (Query & Summary)
export { queryEvidence, summarizeEvidence, evidenceChain } from './evidence-chain.js';
export type { EvidenceQuery, EvidenceEntry } from './evidence-chain.js';

// Cron Utilities
export { matchCronField, getZonedDateParts, matchesCron } from './src/cron-utils.js';
export type { ZonedDateParts } from './src/cron-utils.js';

// Intent Compiler
export { compileIntent, buildPipelineGenerationPrompt, resolveIntentToSteps } from './src/intent-compiler.js';
export type { CompiledIntent } from './src/intent-compiler.js';
export * from './intent-contract.js';
export * from './delegation-request.js';
export * from './assistant-compiler-request.js';
export * from './intent-contract.js';
export * from './delegation-request.js';
export * from './assistant-compiler-request.js';

// Governance & Security (Shield Layer)
export * as tierGuard from './tier-guard.js';
export { 
  detectTier, 
  validateReadPermission, 
  validateWritePermission, 
  scanForConfidentialMarkers, 
  validateSovereignBoundary 
} from './tier-guard.js';

export * as authority from './authority.js';
export { resolveIdentityContext, hasAuthority, inferPersonaFromRole, buildExecutionEnv, withExecutionContext } from './authority.js';

export * as transformer from './transformer.js';
export { transform, getValueByPath } from './transformer.js';

export * as serviceEngine from './service-engine.js';
export { executeServicePreset } from './service-engine.js';
export { compileMusicGenerationADF } from './music-workflow-compiler.js';
export { compileImageGenerationADF, compileVideoGenerationADF } from './visual-workflow-compiler.js';

export * as secretGuard from './secret-guard.js';
export { getSecret, getActiveSecrets, grantAccess, grantAccessGuarded, isSecretPath } from './secret-guard.js';

// Orchestration
export * as orchestrator from './orchestrator.js';

// Domain Engines (Moved to @agent/shared-*)
// export * as excelUtils from './excel-utils.js';
export * as pptxUtils from './src/pptx-utils.js';
export * as xlsxUtils from './src/xlsx-utils.js';
export * as docxUtils from './src/docx-utils.js';
// export * as finance from './finance.js';
// export * as mcpClient from './mcp-client-engine.js';

// Voice & Presentation
export { say, speak } from './voice-synth.js';
export * from './voice-stt.js';
export * from './voice-tts-config.js';
export * from './voice-runtime-policy.js';
export * from './voice-profile-registry.js';
export * from './voice-profile-promotion.js';
export * from './voice-engine-registry.js';
export * from './voice-sample-ingestion-policy.js';
export * from './voice-sample-collection.js';
export * from './voice-sample-recorder.js';
export * from './voice-text-chunking.js';
export * from './voice-generation-runtime.js';
export * from './video-composition-contract.js';
export * from './video-composition-template-registry.js';
export * from './video-render-runtime-policy.js';
export * from './video-render-runtime.js';
export * from './video-composition-compiler.js';
export * from './narrated-video-brief-compiler.js';
export * from './video-render-backend.js';
export * from './surface-action-routing.js';
export * from './platform.js';
export { terminalBridge } from './terminal-bridge.js';
export { ReflexTerminal } from './reflex-terminal.js';
export type { ReflexTerminalOptions } from './reflex-terminal.js';
export * from './sensor-engine.js';
export * from './sensory-memory.js';
export * from './actuator-op-registry.js';
export * from './stimuli-journal.js';

// Mission Status Guard
export { isValidTransition, transitionStatus } from './mission-status.js';
export type { MissionStatus } from './mission-status.js';

// A2UI Protocol
export * from './a2ui.js';

// PTY Engine (Logical Kernel)
export * from './pty-engine.js';
export * from './terminal-keys.js';
export * from './agent-mediator.js';
export * from './acp-mediator.js';
export * from './agent-adapter.js';


// Agent Registry & Lifecycle
export * from './agent-registry.js';
export * from './agent-lifecycle.js';
export * from './a2a-bridge.js';
export * from './agent-manifest.js';
export * from './provider-discovery.js';
export * from './agent-provider-resolution.js';
export * from './runtime-supervisor.js';
export * from './surface-runtime.js';
export * from './artifact-store.js';
export * from './approval-store.js';
export { enforceApprovalGate } from './approval-gate.js';
export type { ApprovalGateParams, ApprovalGateResult } from './approval-gate.js';
export { RISKY_OPS, isKnownRiskyOp, requireApprovalForOp } from './risky-op-registry.js';
export type { RequireApprovalParams, RiskyOpId } from './risky-op-registry.js';
export {
  DEFAULT_THRESHOLDS as INTENT_DRIFT_THRESHOLDS,
  classifyDrift,
  computeIntentDelta,
  goalSimilarity,
  isBlockingDrift,
} from './intent-delta.js';
export type {
  DriftThresholds,
  DriftVerdict,
  IntentBody,
  IntentDelta,
  IntentDeltaChanges,
  IntentSnapshot,
} from './intent-delta.js';
export {
  emitIntentSnapshot,
  evaluateIntentDriftGate,
  latestSnapshot,
  listSnapshots,
  mapStageToLoopPhase,
  reclassifyDrift,
} from './intent-snapshot-store.js';
export type {
  EmitSnapshotParams,
  IntentDriftGateResult,
} from './intent-snapshot-store.js';
export {
  getTrustLevel,
  listNgTopics,
  readNode as readRelationshipNode,
  recordInteraction,
  suggestFieldUpdate,
} from './relationship-graph-store.js';
export {
  listHeuristics,
  queueHeuristicMemoryCandidate,
  readHeuristic,
  scoreValidity,
  summarizeHeuristics,
  validateHeuristic,
} from './heuristic-feedback.js';
export {
  evaluateCustomerSignoffGate,
  evaluateRequirementsCompletenessGate,
  readRequirementsDraft,
  recordCustomerSignoff,
  saveRequirementsDraft,
} from './requirements-draft-store.js';
export type {
  GateResult as RequirementsGateResult,
  RecordSignoffParams,
  RequirementsDraft,
  SaveRequirementsDraftParams,
  SignoffChannel,
  StakeholderSignoff,
} from './requirements-draft-store.js';
export {
  evaluateArchitectureReadyGate,
  evaluateQaReadyGate,
  evaluateTaskPlanReadyGate,
  readDesignSpec,
  readTaskPlan,
  readTestPlan,
  saveDesignSpec,
  saveTaskPlan,
  saveTestPlan,
} from './sdlc-artifact-store.js';
export { executeTaskPlan } from './task-executor.js';
export type {
  ExecuteTaskPlanParams,
  ExecuteTaskPlanResult,
  TaskExecutionRecord,
  TaskExecutionStatus,
} from './task-executor.js';
export {
  getDeploymentAdapter,
  installShellDeploymentAdapterIfAvailable,
  registerDeploymentAdapter,
  resetDeploymentAdapter,
  ShellDeploymentAdapter,
  stubDeploymentAdapter,
} from './deployment-adapter.js';
export type {
  DeployInput,
  DeployResult,
  DeploymentAdapter,
  ShellDeploymentAdapterOptions,
} from './deployment-adapter.js';
export {
  ChainAuditForwarder,
  getAuditForwarder,
  HttpAuditForwarder,
  installAuditForwarderIfAvailable,
  registerAuditForwarder,
  resetAuditForwarder,
  ShellAuditForwarder,
  stubAuditForwarder,
} from './audit-forwarder.js';
export type {
  AuditForwarder,
  HttpAuditForwarderOptions,
  ShellAuditForwarderOptions,
} from './audit-forwarder.js';
export {
  ChainSecretResolver,
  getSecretResolver,
  installSecretResolverIfAvailable,
  registerSecretResolver,
  resetSecretResolver,
  resolveSecretAsync,
  resolveSecretSync,
  ShellSecretResolver,
} from './secret-resolver.js';
export type {
  ResolveSecretInput,
  SecretResolver,
  ShellSecretResolverOptions,
} from './secret-resolver.js';
export type {
  DesignSpec,
  GateResult as SdlcGateResult,
  SaveDesignSpecParams,
  SaveTaskPlanParams,
  SaveTestPlanParams,
  TaskPlan,
  TestPlan,
} from './sdlc-artifact-store.js';
export {
  getReasoningBackend,
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
} from './reasoning-backend.js';
export { AnthropicReasoningBackend } from './anthropic-reasoning-backend.js';
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
export { CodexCliReasoningBackend, buildCodexCliBackendFromEnv } from './codex-cli-reasoning-backend.js';
export type { CodexCliReasoningBackendOptions } from './codex-cli-reasoning-backend.js';
export { CodexCliIntentExtractor } from './codex-cli-intent-extractor.js';
export type { CodexCliIntentExtractorOptions } from './codex-cli-intent-extractor.js';
export { CodexCliVoiceBridge } from './codex-cli-voice-bridge.js';
export type { CodexCliVoiceBridgeOptions } from './codex-cli-voice-bridge.js';
export { runCodexCliQuery, buildCodexCliQueryOptionsFromEnv } from './codex-cli-query.js';
export type { CodexCliQueryOptions, RunCodexCliQueryParams } from './codex-cli-query.js';
export { ClaudeAgentReasoningBackend } from './claude-agent-reasoning-backend.js';
export type { ClaudeAgentReasoningBackendOptions } from './claude-agent-reasoning-backend.js';
export { ClaudeAgentIntentExtractor } from './claude-agent-intent-extractor.js';
export type { ClaudeAgentIntentExtractorOptions } from './claude-agent-intent-extractor.js';
export { ClaudeAgentVoiceBridge } from './claude-agent-voice-bridge.js';
export type { ClaudeAgentVoiceBridgeOptions } from './claude-agent-voice-bridge.js';
export { runClaudeAgentQuery, ClaudeAgentQueryError } from './claude-agent-query.js';
export type { ClaudeAgentQueryParams, ClaudeAgentQueryResult } from './claude-agent-query.js';
export {
  getSpeechToTextBridge,
  installShellSpeechToTextBridgeIfAvailable,
  registerSpeechToTextBridge,
  resetSpeechToTextBridge,
  ShellSpeechToTextBridge,
  stubSpeechToTextBridge,
} from './speech-to-text-bridge.js';
export type {
  ShellSpeechToTextBridgeOptions,
  SpeechToTextBridge,
  TranscribeInput,
  TranscribeResult,
} from './speech-to-text-bridge.js';
export {
  installReasoningBackends,
  installAnthropicBackendsIfAvailable,
  resetReasoningBootstrap,
  getInstalledReasoningMode,
} from './reasoning-bootstrap.js';
export type { InstallAnthropicOptions, InstallReasoningOptions, ReasoningBackendMode } from './reasoning-bootstrap.js';
export type {
  BranchForkInput,
  CritiqueInput,
  CritiqueResult,
  DivergeHypothesisInput,
  ForkedBranch,
  HypothesisSketch,
  PersonaLabel,
  PersonaSynthesisInput,
  ReasoningBackend,
  SimulationInput,
  SimulationResult,
  SynthesizedPersona,
} from './reasoning-backend.js';
export {
  getVoiceBridge,
  registerVoiceBridge,
  resetVoiceBridge,
  stubVoiceBridge,
} from './voice-bridge.js';
export type {
  OneOnOneSessionInput,
  OneOnOneSessionResult,
  RoleplaySessionInput,
  RoleplaySessionResult,
  RoleplayTurn,
  VoiceBridge,
} from './voice-bridge.js';
export type {
  HeuristicEntry,
  HeuristicReport,
  HeuristicValidation,
  MissionOutcome,
  ValidateParams as ValidateHeuristicParams,
} from './heuristic-feedback.js';
export type {
  InteractionEntry,
  PendingSuggestion,
  RecordInteractionParams,
  RelationshipIdentity,
  RelationshipNode,
  RelationshipSource,
  SuggestFieldUpdateParams,
} from './relationship-graph-store.js';
export * from './distill-candidate-registry.js';
export * from './promoted-memory.js';
export * from './memory-promotion-queue.js';
export * from './memory-promotion-workflow.js';
export * from './managed-process.js';
export * from './mission-seed-registry.js';
export * from './mission-working-memory.js';
export * from './mission-classification.js';
export * from './mission-workflow-catalog.js';
export * from './mission-review-gates.js';
export * from './delegation-preflight.js';
export * from './mission-orchestration-evaluator.js';
export * from './mission-coordination-bus.js';
export * from './mission-team-composer.js';
export * from './mission-team-binding.js';
export * from './mission-team-orchestrator.js';
export * from './agent-runtime-supervisor.js';
export * from './agent-runtime-supervisor-client.js';
export * from './mission-orchestration-events.js';
export * from './mission-orchestration-worker.js';
export * from './mission-task-events.js';
export * from './worker-assignment-policy.js';
export * from './pipeline-contract.js';
export * from './realtime-voice-conversation.js';
export * from './surface-coordination-store.js';
export * from './surface-ingress-contract.js';
export * from './surface-interaction-model.js';
export * from './surface-provider-manifest.js';
export * from './surface-provider-policy.js';
export { resolveRef, handleStepError } from './src/pipeline-engine.js';
export type { OnErrorConfig, RefParams } from './src/pipeline-engine.js';
export * from './channel-surface.js';
export * from './surface-runtime-router.js';
export * from './surface-runtime-orchestrator.js';
export * from './surface-response-blocks.js';
export * from './surface-artifact-store.js';
export * from './surface-mission-proposals.js';
export * from './slack-approval-ui.js';
export * from './slack-onboarding.js';
// Surface-level type definitions (importable without pulling in channel-surface implementation)
export type * from './channel-surface-types.js';

export * from './browser-conversation-session.js';
export * from './presence-surface.js';
export * from './presence-avatar.js';
export * from './presence-bridge.js';
export * from './surface-agent-catalog.js';
export * from './surface-query.js';
export * from './surface-ux-contract.js';
export * from './next-action-contract.js';
export * from './task-session.js';
export * from './intent-resolution.js';
export * from './intent-resolution-contract.js';
export * from './outcome-contract.js';
export * from './analysis-contract.js';
export * from './approval-policy.js';
export * from './router-contract.js';
export * from './analysis-intent-support.js';
export * from './intent-outcome-patterns.js';
export * from './analysis-corpus.js';
export * from './analysis-impact-bands.js';
export * from './analysis-findings.js';
export * from './analysis-execution-contract.js';
export * from './work-design.js';
export * from './project-registry.js';
export * from './project-track-registry.js';
export * from './sdlc-gate-readiness.js';
export * from './service-binding-registry.js';
export * from './artifact-record.js';
export * from './artifact-registry.js';
export * from './control-plane-client.js';
export * from './computer-surface.js';
export * from './apple-event-bridge.js';
export * from './os-app-adapters.js';
export * from './service-binding.js';
export * from './oauth-broker.js';
export * from './generation-scheduler.js';
export * from './src/pipeline-scheduler.js';
export * from './src/pipeline-preview.js';

// Governance (Agent Governance Toolkit inspired)
export * from './policy-engine.js';
export * from './trust-engine.js';
export * from './audit-chain.js';
export * from './agent-slo.js';
export * from './kill-switch.js';


// Shared Business Types
export * from './shared-business-types.js';
export * from './types.js';
// export * as visionJudge from './vision-judge.js';

// Actuator Capability Contracts (Dynamic Runtime Detection)
export { checkActuatorCapabilities, checkAllActuatorCapabilities, registerCapabilityProbe } from './src/actuator-capability.js';
export type { ActuatorCapability, ActuatorStatus } from './src/actuator-capability.js';

// Pre-Flight Check (Sovereign Sentinel)
export * from './src/pfc/PfcController.js';
export * from './src/pfc/PhysicalLayer.js';
export * from './src/pfc/ServiceValidator.js';
export * from './src/pfc/SovereignSentinel.js';

// Observability (Unified Trace Model)
export { TraceContext } from './src/trace.js';
export type { Trace, TraceSpan, TraceEvent, TraceArtifact } from './src/trace.js';

// Feedback Loop (Closed-Loop Automation)
export { extractHintsFromTrace, persistHints, checkScheduleHealth, recordPipelineResult, runFeedbackLoop } from './src/feedback-loop.js';
