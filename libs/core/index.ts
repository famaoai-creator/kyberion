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
  loadJson,
  safeWriteFile,
  safeAppendFileSync,
  safeCopyFileSync,
  safeMoveSync,
  safeSymlinkSync,
  safeRmSync,
  safeUnlinkSync,
  safeMkdir,
  ensureDir,
  safeExistsSync,
  safeExec,
  safeExecResult,
  buildSafeExecEnv,
  safeReaddir,
  safeStat,
  safeLstat,
  safeReadlink,
  safeOpenAppendFile,
  safeFsyncFile,
  safeCreateExclusiveFileSync,
} from './secure-io.js';

// Backward compatibility aliases
export { safeAppendFileSync as safeAppendFile, safeUnlinkSync as safeUnlink } from './secure-io.js';

// Paths & Navigation
export * as pathResolver from './path-resolver.js';
export type { VolatileScope, VolatileCadence } from './path-resolver.js';
export * as customerResolver from './customer-resolver.js';

// Error Classification (Phase A-7)
export {
  classifyError,
  buildUserFacingError,
  formatClassification,
  getRuleIds as getErrorClassifierRuleIds,
} from './error-classifier.js';
export type {
  ErrorCategory,
  ErrorClassification,
  UserFacingErrorEnvelope,
} from './error-classifier.js';

// Native OS TTS (Phase A-5, voice tier 0)
export {
  speak as nativeTtsSpeak,
  probeNativeTts,
  currentPlatform as nativeTtsCurrentPlatform,
  hasBuiltInTts as nativeTtsHasBuiltIn,
} from './native-tts.js';
export type {
  SpeakOptions as NativeTtsSpeakOptions,
  SpeakResult as NativeTtsSpeakResult,
  Platform as NativeTtsPlatform,
} from './native-tts.js';
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
  projectWorkspaceDir,
  projectOsDir,
  projectStateDir,
  tenantMissionDir,
  missionEvidenceDir,
  findMissionPath,
  resolve,
  rootResolve,
} from './path-resolver.js';
export { resolveTenantDesign } from './tenant-design-resolver.js';
export * from './creative-design-resolver.js';
export * from './campaign-suite.js';
export * from './marketing-workload.js';
export * from './artifact-review.js';
export * from './customer-channel-binding.js';
export * from './deal-store.js';
export * from './customer-conversation.js';
export * from './customer-conversation-modes.js';
export * from './operator-notifications.js';
export * from './deal-documents.js';
export * from './mission-retrospective.js';
export * from './working-principles.js';
export * from './design-qa.js';
export * from './apple-intelligence-bridge.js';
export * from './ten-vad-bridge.js';
export * from './mission-hygiene.js';
export * from './context-security-scope.js';
export * from './reasoning-participant.js';
export * from './participant-context-resolver.js';
export * from './context-promotion-ledger.js';

// Utils
export * from './fs-utils.js';
export * from './cli-utils.js';
export * from './async-utils.js';
export * from './recovery-policy.js';
export * from './command-runner.js';
export * from './job-lifecycle.js';
export * from './voice-capability-bridge.js';
export * from './voice-path-policy.js';
export * from './ledger.js';
export * from './text-utils.js';
export * from './src/logic-utils.js';
export * from './src/lock-utils.js';
export * from './src/retry-utils.js';
export { parseData, stringifyData } from './data-utils.js'; // Explicitly avoid detectFormat conflict
export * from './detectors.js';
export * from './validators.js';
export * from './mobile-profile-validators.js';
export * from './schema-loader.js';
export * from './operator-learning.js';
export * from './question-resolver.js';
export * from './op-input-contracts.js';
export * from './op-suggestions.js';
export * from './adf-engine.js';
export * from './tool-call-scheduler.js';
export * from './autonomous-repair.js';
export * from './operation-policy-gate.js';
export * from './video-visual-direction.js';
export * from './video-motion-direction.js';
export * from './video-scene-composition.js';
export * from './video-composition-lint.js';
export * from './reasoning-egress-scope.js';
export * from './visual-raster.js';
export * from './visual-review.js';
export * from './visual-review-loop.js';
export * from './media-brief-lock.js';
export * from './house-style-distillation.js';
export * from './deck-theme-direction.js';
export * from './semantic-decide.js';
export * from './observation-distill.js';
export * from './ranking-signals.js';
export * from './operation-policy-gate.js';
export * from './ranking-signals.js';
export * from './runtime-health-history.js';
export * from './bridge-typing.js';
export * from './draft-refine.js';
export * from './gemini-embedding-backend.js';
export * from './process-guards.js';
export * from './process-guards.js';
export * from './guided-coordination-brief.js';
export * from './email-workflow.js';
export * from './calendar-workflow.js';
export * from './op-vocabulary.js';
export * from './mission-gate-engine.js';
export * from './mission-process-task-expansion.js';
export * from './handoff-packet.js';
export * from './presentation-slide-pattern.js';
export * from './web-design-system.js';
export * from './managed-process.js';
export * from './meeting-environment-policy.js';
export * from './meeting-participation-runtime-plan.js';
export * from './deliverable-quality.js';
export * from './deliverable-inbox.js';
export * from './src/font-stack.js';
export { resolveInputBindings, classifyInputId, isPathInput } from './input-binding.js';
export type { InputBinding, InputBindingType } from './input-binding.js';
export { distillIncident, summarizeIncidents } from './incident-distiller.js';
export type { IncidentInput, IncidentRecord } from './incident-distiller.js';
export * from './autonomous-ops-gate.js';
export * from './patch-decision.js';
export { recordTelemetryEvent, isTelemetryEnabled, readTelemetryStats } from './telemetry.js';
export type { TelemetryEvent, TelemetryEventType, TelemetryStats } from './telemetry.js';
export {
  buildNextAction,
  buildNextActionFromError,
  buildCompletionNextAction,
  formatCompletionNextAction,
  formatNextAction,
} from './next-action.js';
export { buildCompletionSummary, reconcileCompletion } from './intent-reconciliation.js';
export type {
  BuildNextActionInput,
  ErrorNextActionContext,
  CompletionGoal,
  CompletionNextAction,
  CompletionReconciliation,
  NextAction,
  NextActionType,
} from './next-action.js';
export { renderStatus, renderVocabularyText, resolveVocabularyLocale } from './ux-vocabulary.js';
export type { UxStatusDomain, UxVocabularyLocale } from './ux-vocabulary.js';
export * from './operator-home-summary.js';
export { resolveActiveProfileRoot } from './profile-root.js';
export * from './browser-onboarding.js';
export { resolveOperatorDisplayName, resolveOperatorLocale } from './operator-identity.js';
export * from './company.js';
export * from './financial-model.js';
export * from './finance-controller.js';
export * from './okr-tracker.js';
export * from './decision-rights.js';
export * from './vision-resolver.js';
export * from './approval-audit.js';
export * from './org-chart.js';
export * from './daemon-heartbeat.js';
export * from './ops-alert.js';
export * from './health-degradation.js';
export * from './aidlc-phase-state.js';
export * from './secret-encryption.js';
export * from './spend-guard.js';
export * from './cost-report.js';
export * from './chain-integrity.js';

// Classification & Knowledge
export * as classifier from './classifier.js';
export * from './knowledge-provider.js';
export {
  buildKnowledgeIndex,
  buildScopedIndex,
  queryKnowledge,
  queryKnowledgeHybrid,
  clearKnowledgeEmbedCache,
  KnowledgeHintIndex,
  DEFAULT_SCOPE,
  computeScopeHash,
} from './src/knowledge-index.js';
export type {
  KnowledgeHint,
  KnowledgeQueryOptions,
  KnowledgeScope,
} from './src/knowledge-index.js';

// Networking
export { secureFetch } from './network.js';
export {
  buildPeerMessageEnvelope,
  clearPeerRuntime,
  createPeerMessageNotification,
  createPeerMessageRequest,
  createPeerMessagingServer,
  ensurePeerRuntimeDir,
  loadPeerNetworkCatalog,
  listPeerEvents,
  listPeerInboxRecords,
  listPeerOutboxRecords,
  persistPeerRuntimeState,
  resolvePeerRecord,
  resolvePeerDispatchTarget,
  sendPeerMessage,
  sendPeerMessageToPeer,
  signPeerMessage,
  verifyPeerMessage,
} from './peer-messaging.js';
export type {
  BuildPeerMessageInput,
  PeerMessageDispatchOptions,
  PeerMessageDispatchReceipt,
  PeerMessageEnvelope,
  PeerMessageResponder,
  PeerMessageResponderContext,
  PeerMessageType,
  PeerMessagingCatalogOptions,
  PeerMessagingServerOptions,
  PeerNetworkCatalog,
  PeerNetworkPeerRecord,
  ResolvedPeerDispatchTarget,
} from './peer-messaging.js';
export {
  advertiseMeshCapabilities,
  expireMeshPresence,
  listEligibleMeshPeers,
  listMeshPeerDirectoryEntries,
  recordMeshHeartbeat,
  registerMeshPeer,
  resolveMeshPeer,
} from './mesh-peer-directory.js';
export type {
  AdvertiseMeshCapabilitiesInput,
  MeshPeerDirectoryEntry,
  MeshPeerDirectoryPolicyContext,
  RecordMeshHeartbeatInput,
  RegisterMeshPeerInput,
} from './mesh-peer-directory.js';
export {
  clearMeshTopicRegistryNamespace,
  listMeshTopicSubscriptions,
  resolveMeshTopicRecipients,
  subscribeMeshTopic,
} from './mesh-topic-registry.js';
export type {
  MeshTopicRegistryPolicyContext,
  MeshTopicResolution,
  MeshTopicResolutionOptions,
  MeshTopicSubscriptionFilter,
  MeshTopicSubscriptionInput,
} from './mesh-topic-registry.js';
export {
  clearMeshHubPeerMessagingAdapterNamespace,
  createMeshHubPeerMessagingAdapter,
  decideMeshHubRecipientProposal,
  listMeshHubRecipientProposals,
  MeshHubPeerMessagingAdapter,
} from './mesh-hub-peer-messaging-adapter.js';
export type {
  MeshHubDispatchInput,
  MeshHubPeerMessagingAdapterOptions,
  MeshHubRecipientProposalDecision,
  MeshHubRecipientProposalRecord,
  MeshHubRecipientProposalView,
} from './mesh-hub-peer-messaging-adapter.js';
export type { MeshRequest } from './mesh-hub-contract.js';
export { routeMeshRequest } from './mesh-router.js';
export type {
  MeshRouteCandidate,
  MeshRouteDecision,
  MeshRouteExclusion,
  MeshRouteOptions,
} from './mesh-router.js';
export { formatMeshHubInspectionReport, inspectMeshHub } from './mesh-hub-inspection.js';
export type {
  MeshHubDeliveryInspection,
  MeshHubInspectionOptions,
  MeshHubInspectionReport,
  MeshHubPeerInspection,
  MeshHubTopicInspection,
} from './mesh-hub-inspection.js';
export {
  appendCoordinationEvent,
  claimWorkItem,
  clearWorkCoordinationStore,
  clearWorkCoordinationNamespace,
  createBoard,
  createDefaultWorkBoard,
  createWorkItem,
  describeWorkCoordinationStore,
  expireWorkItemLeases,
  getBoard,
  getWorkItem,
  handoffWorkItem,
  importExternalWorkItem,
  listActiveWorkLeases,
  listBoardItems,
  listBoards,
  listCoordinationEvents,
  listWorkItems,
  normalizeWorkItemLabels,
  releaseWorkItem,
  renewWorkItemLease,
  setWorkCoordinationNamespace,
  WorkCoordinationError,
  updateWorkItem,
} from './work-coordination.js';
export type {
  AppendCoordinationEventInput,
  ClaimWorkItemInput,
  CoordinationEvent,
  CreateBoardInput,
  CreateWorkItemInput,
  HandoffWorkItemInput,
  ReleaseWorkItemInput,
  RenewWorkItemLeaseInput,
  UpdateWorkItemInput,
  WorkBoard,
  WorkBoardFilter,
  WorkBoardType,
  WorkCoordinationEventType,
  WorkItem,
  WorkItemFilter,
  WorkItemPriority,
  WorkItemSource,
  WorkItemStatus,
  WorkLease,
  WorkLeaseStatus,
} from './work-coordination.js';
export type {
  WorkCoordinationPeerCommandEnvelope,
  WorkCoordinationPeerCommandPayload,
  WorkCoordinationPeerCommandResult,
  WorkCoordinationPeerCommandType,
} from './work-coordination-peer.js';
export {
  buildWorkCoordinationPeerCommandEnvelope,
  createWorkCoordinationPeerResponder,
  processWorkCoordinationPeerCommand,
} from './work-coordination-peer.js';
export {
  importGitHubIssue,
  importGitHubIssueWithEvent,
  normalizeGitHubIssue,
} from './work-integrations/github-issues.js';
export type {
  GitHubIssueLike,
  GitHubIssueNormalizationResult,
} from './work-integrations/github-issues.js';
export {
  importJiraIssue,
  importJiraIssueWithEvent,
  normalizeJiraIssue,
} from './work-integrations/jira-issues.js';
export type {
  JiraIssueLike,
  JiraIssueNormalizationResult,
} from './work-integrations/jira-issues.js';
export {
  getWorkCoordinationImportCatalogEntryByCommand,
  listWorkCoordinationImportCatalogEntries,
  loadWorkCoordinationImportCatalog,
} from './work-coordination-import-catalog.js';
export type { WorkCoordinationImportCatalogEntry } from './work-coordination-import-catalog.js';
export {
  getServiceBootstrapCatalogEntryByServiceId,
  findServiceBootstrapEntriesByUtterance,
  getDefaultServiceIdForSurface,
  loadServiceBootstrapCatalog,
  listServiceBootstrapCatalogEntries,
} from './service-bootstrap-catalog.js';
export type { ServiceBootstrapCatalogEntry } from './service-bootstrap-catalog.js';
export {
  getActuatorDependencyBundle,
  loadActuatorDependencyBundles,
} from './actuator-dependency-bundles.js';
export type { ActuatorDependencyBundleEntry } from './actuator-dependency-bundles.js';
export {
  findSkillInstallPackageMapEntry,
  loadSkillInstallPackageMap,
} from './skill-install-package-map.js';
export type { SkillInstallPackageMapEntry } from './skill-install-package-map.js';
export {
  getServiceAuthorities,
  listServiceAuthorityMapEntries,
  loadServiceAuthorityMap,
} from './service-authority-map.js';
export type { ServiceAuthorityMapEntry } from './service-authority-map.js';
export { getSurfaceCoordinationRole } from './surface-coordination-role-map.js';
export { distillPdfDesign } from './src/pdf-utils.js';
export { distillPptxDesign } from './src/pptx-utils.js';
export { distillXlsxDesign } from './src/xlsx-utils.js';
export { distillDocxDesign } from './src/docx-utils.js';
export { generateNativePdf } from './src/native-pdf-engine/engine.js';
export { generateNativePptx, patchPptxText } from './src/native-pptx-engine/engine.js';
export {
  applyPptxDesignDefaults,
  resolvePptxDesignDefaults,
  designDefaultsFromMediaTheme,
  resolvePptxSurfaceDesign,
  type PptxDesignDefaults,
  type PptxDesignDefaultsInput,
} from './src/native-pptx-engine/design-cascade.js';
export {
  fitTextToBox,
  measureTextBlock,
  measureTextWidthPt,
  splitLinesBalanced,
  wrapLine,
  type LayoutFitRequest,
  type LayoutFitResult,
  type TextMeasurement,
} from './src/native-pptx-engine/text-metrics.js';
export {
  PPTX_PALETTE,
  textElement,
  shapeElement,
  lineElement,
  sectionHeaderElements,
  footerElements,
  type SectionHeaderOptions,
  type FooterOptions,
} from './src/native-pptx-engine/layout-primitives.js';
export type { PptxDesignProtocol, PptxElement, PptxSlide } from './src/types/pptx-protocol.js';
export { generateNativeXlsx } from './src/native-xlsx-engine/engine.js';
export { generateNativeDocx } from './src/native-docx-engine/engine.js';
export {
  protocolToMarkdown,
  pdfToMarkdown,
  docxToMarkdown,
  xlsxToMarkdown,
  pptxToMarkdown,
  extractTablesFromPage,
} from './src/protocol-to-markdown.js';
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
export type {
  PdfDesignProtocol,
  PdfAesthetic,
  PdfLayoutElement,
  PdfPage,
} from './src/types/pdf-protocol.js';

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
export {
  compileIntent,
  buildPipelineGenerationPrompt,
  resolveIntentToSteps,
} from './src/intent-compiler.js';
export type { CompiledIntent } from './src/intent-compiler.js';
export * from './intent-contract.js';
export * from './intent-use-case-scenario.js';
export * from './execution-feedback.js';
export * from './intent-contract-learning.js';
export * from './contextual-intent-frame.js';
export * from './contextual-intent-clarification-policy.js';
export * from './contextual-intent-memory.js';
export * from './contextual-intent-learning.js';
export * from './execution-brief.js';
export * from './tool-actuator-routing.js';
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
  validateSovereignBoundary,
} from './tier-guard.js';

export * as authority from './authority.js';
export {
  resolveIdentityContext,
  hasAuthority,
  inferPersonaFromRole,
  buildExecutionEnv,
  withExecutionContext,
} from './authority.js';

export * as transformer from './transformer.js';
export { transform, getValueByPath } from './transformer.js';

export * as serviceEngine from './service-engine.js';
export { executeServicePreset, executeMcp } from './service-engine.js';
export * from './service-preset-registry.js';
export * from './service-preset-policy.js';
export {
  getServiceEndpointRecord,
  loadServiceEndpointsCatalog,
  resolveServiceBinding,
} from './service-binding.js';
export { compileMusicGenerationADF } from './music-workflow-compiler.js';
export {
  compileImageGenerationADF,
  compileVideoGenerationADF,
} from './visual-workflow-compiler.js';

export * as secretGuard from './secret-guard.js';
export {
  getSecret,
  getActiveSecrets,
  grantAccess,
  grantAccessGuarded,
  isSecretPath,
} from './secret-guard.js';
export * from './shell-command-policy.js';
export * from './sensitive-path-policy.js';
export * from './output-artifacts.js';
export * from './worker-context-compaction.js';
export * from './completion-token-budget.js';
export * from './worker-event-stream.js';
export * from './lifecycle-hook-engine.js';
export * from './dynamic-injection.js';
export * from './prompt-cache-discipline.js';
export * from './context-rewind.js';
export * from './worker-goal.js';
export * from './worker-goal-driver.js';
export * from './worker-state-journal.js';
export * from './adf-guardrails.js';
export * from './reconcile-ops.js';
export * from './report-ops.js';
export * from './execution-bounds.js';
export * from './intent-handoff.js';
export * from './mesh-message-broker.js';
export * from './mesh-delivery-driver.js';
export * from './egress-policy.js';
export * from './governance-status.js';

// Orchestration
export * as orchestrator from './orchestrator.js';
export { composeMissionTeamBrief, writeMissionTeamBrief } from './mission-team-brief-composer.js';

// Domain Engines (excel distiller moved to @agent/shared-media)
export * as pptxUtils from './src/pptx-utils.js';
export * as xlsxUtils from './src/xlsx-utils.js';
export * as docxUtils from './src/docx-utils.js';
// export * as finance from './finance.js';
// export * as mcpClient from './mcp-client-engine.js';

// Voice & Presentation
export { say, speak } from './voice-synth.js';
export * from './voice-stt.js';
export * from './voice-provider-adapters.js';
export * from './voice-selection-preferences.js';
export * from './native-speech-listen-bridge.js';
export {
  AppleVisionOcrProvider,
  LlmApiOcrProvider,
  LocalVlmOcrProvider,
  TesseractOcrProvider,
  ocrImage,
  ocrImageWithRouter,
  AdaptivePolicyRouter as OcrAdaptivePolicyRouter,
} from './ocr-bridge.js';
export * from './ocr-types.js';
export * from './secret-bridge.js';
export * from './secret-types.js';
export * from './email-bridge.js';
export * from './email-types.js';
export * from './image-generation-bridge.js';
export * from './image-generation-types.js';
export * from './image-generation-policy.js';
export * from './tool-runtime-policy.js';
export * from './tool-runtime-registry.js';
export * from './service-runtime-policy.js';
export * from './service-runtime-registry.js';
export * from './voice-tts-config.js';
export * from './voice-runtime-policy.js';
export * from './voice-profile-registry.js';
export * from './voice-transcript-alignment.js';
export * from './voice-profile-promotion.js';
export * from './presentation-preference-registry.js';
export * from './imessage-bridge.js';
export * from './imessage-utils.js';
export * from './bluebubbles-adapter.js';
export * from './history-search-index.js';
export * from './voice-engine-registry.js';
export * from './media-backend-registry.js';
export * from './adapter-default-preferences.js';
export * from './adapter-default-selection.js';
export * from './intent-execution-profile-registry.js';
export * from './voice-sample-ingestion-policy.js';
export * from './voice-sample-collection.js';
export * from './voice-sample-recorder.js';
export * from './voice-text-chunking.js';
export * from './voice-generation-runtime.js';
export * from './video-composition-contract.js';
export * from './video-content-brief-contract.js';
export * from './video-composition-template-registry.js';
export * from './video-render-runtime-policy.js';
export * from './video-render-runtime.js';
export * from './video-composition-compiler.js';
export * from './narrated-video-brief-compiler.js';
export * from './video-content-brief-compiler.js';
export * from './video-render-backend.js';
export * from './surface-action-routing.js';
export * from './platform.js';
export { terminalBridge } from './terminal-bridge.js';
export { ReflexTerminal } from './reflex-terminal.js';
export type { ReflexTerminalOptions } from './reflex-terminal.js';
export * from './sensor-engine.js';
export * from './sensory-memory.js';
export * from './provider-capability-scanner.js';
export * from './provider-capability-overview.js';
export * from './provider-bridge.js';
export * from './provider-permission-profiles.js';
export * from './claude-task-runner.js';
export * from './claude-task-session-executor.js';
export * from './actuator-op-registry.js';
export * from './stimuli-journal.js';

// Mission Status Guard
export { isValidTransition, transitionStatus } from './mission-status.js';
export type { MissionStatus } from './mission-status.js';

// Gate Status Guard
export { isValidGateTransition, transitionGateStatus } from './gate-status.js';
export type { GateStatus } from './gate-status.js';

// Storage Governance
export {
  scanTmp,
  rotateLogs,
  scanDataVault,
  runJanitor,
  runJanitorIfStale,
  readJanitorLastRunMs,
  DEFAULT_TMP_TTL_MS,
  DEFAULT_LOG_RETENTION_DAYS,
} from './storage-janitor.js';
export type {
  JanitorReport,
  ScanTmpResult,
  RotateLogsResult,
  ScanDataVaultResult,
} from './storage-janitor.js';

// Data Vault (external data source reference cache)
export {
  fetchWithVaultCache,
  getVaultEntry,
  invalidateVaultEntry,
  listVaultEntries,
} from './data-vault.js';
export type {
  VaultEntry,
  FetchWithVaultCacheOptions,
  FetchWithVaultCacheResult,
  DataVaultTier,
  VaultEntryFilter,
} from './data-vault.js';

// Process Logger (file-backed logger for long-running daemons)
export {
  createProcessLogger,
  resetProcessLoggerRegistry,
  ProcessLogger,
} from './process-logger.js';
export type { ProcessLogEntry, ProcessLogLevel, ProcessLoggerOptions } from './process-logger.js';

// Service Engine (vault-cached variant)
export type { ServicePresetCacheOptions } from './service-engine.js';
export { executeServicePresetCached } from './service-engine.js';

// Path helpers (log sub-directories)
export {
  sharedLogsAudit,
  sharedLogsProcess,
  sharedLogsSurfaces,
  sharedLogsTraces,
  missionAuditDir,
} from './path-resolver.js';

// A2UI Protocol
export * from './a2ui.js';

// PTY Engine (Logical Kernel)
export * from './pty-engine.js';
export * from './terminal-keys.js';
export * from './agent-mediator.js';
export * from './acp-mediator.js';
export * from './copilot-acp-reasoning-backend.js';
export * from './agent-adapter.js';

// Agent Registry & Lifecycle
export * from './agent-registry.js';
export * from './agent-lifecycle.js';
export * from './a2a-bridge.js';
export * from './a2a-conversation-store.js';
export * from './agent-manifest.js';
export * from './provider-discovery.js';
export * from './provider-capability-registry.js';
export * from './provider-egress-gate.js';
export * from './agent-provider-resolution.js';
export * from './provider-health-registry.js';
export * from './capability-broker.js';
export * from './runtime-supervisor.js';
export * from './surface-runtime.js';
export * from './organization-profile.js';
export * from './artifact-store.js';
export * from './approval-store.js';
export * from './plugin-source-trust.js';
export * from './plugin-managed-install.js';
export * from './skill-plugin-loader.js';
export * from './provider-capability-scanner.js';
export * from './approval-gate-summary.js';
export { enforceApprovalGate } from './approval-gate.js';
export type { ApprovalGateParams, ApprovalGateResult } from './approval-gate.js';
export * from './lead-score.js';
export * from './inbound-inquiry-adapter.js';
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
export type { EmitSnapshotParams, IntentDriftGateResult } from './intent-snapshot-store.js';
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
export {
  getTaskPlanCoordinator,
  registerTaskPlanCoordinator,
  resetTaskPlanCoordinator,
} from './task-plan-coordinator-port.js';
export type {
  ExecuteTaskPlanParams,
  ExecuteTaskPlanResult,
  TaskExecutionRecord,
  TaskExecutionStatus,
  TaskPlanCoordinatorPort,
} from './task-plan-coordinator-port.js';
export {
  getAgentExecutionPort,
  registerAgentExecutionPort,
  SupervisorAgentExecutionPort,
} from './agent-execution-port.js';
export type {
  AgentExecutionPort,
  AgentExecutionReceipt,
  AgentTaskEnvelope,
} from './agent-execution-port.js';
export {
  getActuatorForwardingPort,
  registerActuatorForwardingPort,
  resetActuatorForwardingPort,
  withActuatorForwardingPort,
} from './actuator-forwarding-port.js';
export type {
  ActuatorForwardingPort,
  ActuatorForwardStatus,
  ActuatorForwardRequest,
  ActuatorForwardReceipt,
} from './actuator-forwarding-port.js';
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
export { MobileBetaDeploymentAdapter } from './deployment-adapters/mobile-beta.js';
export type { MobileBetaAdapterOptions } from './deployment-adapters/mobile-beta.js';
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
export {
  consumeTenantBudget,
  inspectTenantBudget,
  withTenantBudget,
  TenantRateLimitExceededError,
} from './tenant-rate-limiter.js';
export type { RateLimitDecision } from './tenant-rate-limiter.js';
export {
  findRelevantDistilledKnowledge,
  formatDistilledKnowledgeSummary,
} from './distill-knowledge-injector.js';
export type { DistilledKnowledgeEntry, FindRelevantInput } from './distill-knowledge-injector.js';
export {
  loadKnowledgeSlicesFile,
  resolveKnowledgeSlice,
  matchesKnowledgeGlob,
  isKnowledgePathExcluded,
  isKnowledgePathInSearchRoots,
  _resetKnowledgeSlicesCacheForTests,
} from './knowledge-slices.js';
export type {
  KnowledgeSliceMatcher,
  KnowledgeSliceDefinition,
  KnowledgeSlicesFile,
  ResolveKnowledgeSliceInput,
  ResolvedKnowledgeSlice,
} from './knowledge-slices.js';
export { loadRestrictedActionRules, matchRestrictedAction } from './restricted-action-policy.js';
export type { RestrictedActionMatch, RestrictedActionRule } from './restricted-action-policy.js';
export { loadMeetingFacilitatorPolicy } from './meeting-facilitator-policy.js';
export type { MeetingFacilitatorPolicy } from './meeting-facilitator-policy.js';
export { MissionEvidenceDoc } from './mission-evidence-doc.js';
export type { MissionEvidenceDocOptions } from './mission-evidence-doc.js';
export {
  bootstrapManifest,
  computeManifestSignature,
  loadEnvironmentManifest,
  listEnvironmentManifestIds,
  probeManifest,
  registerEnvironmentCapabilityProbe,
  resetEnvironmentCapabilityProbeRegistry,
  verifyManifestSignature,
  verifyReady,
} from './environment-capability.js';
export { installCoreEnvironmentProbes } from './environment-capability-probes.js';
export {
  formatEnvValidationReport,
  loadEnvRegistryEntries,
  validateEnv,
  validateEnvAgainstRegistry,
} from './env-validator.js';
export type {
  EnvRegistryValidationEntry,
  EnvValidationIssue,
  EnvValidationReport,
} from './env-validator.js';
export type {
  BootstrapOptions,
  CapabilityInstall,
  CapabilityKind,
  CapabilityProbe,
  CapabilityStatus,
  EnvironmentCapability,
  EnvironmentManifest,
  ReadinessReport,
  SetupReceipt,
} from './environment-capability.js';
export type {
  AudioChunk,
  AudioFormat,
  MeetingPlatform,
  MeetingSession,
  MeetingSessionState,
  MeetingSessionStatus,
  MeetingTarget,
  TranscriptChunk,
} from './meeting-session-types.js';
export { abortableAudioChunks } from './meeting-session-types.js';
export * from './barge-in-controller.js';
export { StubAudioBus } from './audio-bus.js';
export type { AudioBus, AudioBusProbe } from './audio-bus.js';
export { BlackHoleAudioBus } from './blackhole-audio-bus.js';
export type { BlackHoleBusOptions } from './blackhole-audio-bus.js';
export { PulseAudioBus } from './pulse-audio-bus.js';
export type { PulseAudioBusOptions } from './pulse-audio-bus.js';
export { resolveAudioBus } from './audio-bus-resolver.js';
export type { AudioBusId } from './audio-bus-resolver.js';
export * from './audio-route.js';
export * from './bounded-audio-queue.js';
export * from './audio-text-similarity.js';
export * from './coreaudio-device-inventory.js';
export * from './coreaudio-output-bridge.js';
export * from './tts-loopback-verifier.js';
export * from './audio-device-lease.js';
export { StubVideoFrameBus } from './video-frame-bus.js';
export type { VideoFrameBus, VideoFrameBusProbe } from './video-frame-bus.js';
export {
  pipeMp4ToVideoFrameBus,
  readVideoFramesFromMp4,
  writeVideoFrameBusToMp4,
  writeVideoFramesToMp4,
} from './video-frame-archive.js';
export type { VideoFrameArchiveOptions, VideoFrameArchiveResult } from './video-frame-archive.js';
export { SCREEN_CAPTURE_BRIDGE_ID, createScreenCaptureBridge } from './screen-capture-bridge.js';
export type {
  ScreenCaptureBridge,
  ScreenCaptureBridgeOptions,
  ScreenCaptureBridgeProbe,
  ScreenCaptureBackendId,
  ScreenCaptureRequest,
  ScreenCaptureStreamRequest,
  ScreenCaptureResult,
} from './screen-capture-bridge.js';
export {
  SCREEN_RECORDING_BRIDGE_ID,
  createScreenRecordingBridge,
} from './screen-recording-bridge.js';
export type {
  ScreenRecordingBridge,
  ScreenRecordingBridgeOptions,
  ScreenRecordingBridgeProbe,
} from './screen-recording-bridge.js';
export {
  SCREEN_DISPLAY_INVENTORY_BRIDGE_ID,
  createScreenDisplayInventoryBridge,
} from './screen-display-inventory-bridge.js';
export type {
  ScreenDisplayInventoryBridge,
  ScreenDisplayInventoryOptions,
  ScreenDisplayInventoryProbe,
  ScreenDisplayInventory,
  ScreenDisplayRecord,
} from './screen-display-inventory-bridge.js';
export {
  VIRTUAL_AUDIO_DEVICE_BRIDGE_ID,
  createVirtualAudioDeviceBridge,
} from './virtual-audio-device-bridge.js';
export type {
  VirtualAudioDeviceBridge,
  VirtualAudioDeviceBridgeOptions,
  VirtualAudioDeviceBridgeProbe,
} from './virtual-audio-device-bridge.js';
export {
  VIRTUAL_AUDIO_OUTPUT_PLAYBACK_BRIDGE_ID,
  createVirtualAudioOutputPlaybackBridge,
} from './virtual-audio-output-playback-bridge.js';
export type {
  VirtualAudioOutputPlaybackBridge,
  VirtualAudioOutputPlaybackBridgeOptions,
  VirtualAudioOutputPlaybackProbe,
  VirtualAudioOutputPlaybackTargetResult,
} from './virtual-audio-output-playback-bridge.js';
export {
  VIRTUAL_AUDIO_INPUT_RECORDING_BRIDGE_ID,
  createVirtualAudioInputRecordingBridge,
} from './virtual-audio-input-recording-bridge.js';
export type {
  VirtualAudioInputRecordingBridge,
  VirtualAudioInputRecordingBridgeOptions,
  VirtualAudioInputRecordingProbe,
  VirtualAudioInputRecordingRequest,
  VirtualAudioInputRecordingTargetResult,
} from './virtual-audio-input-recording-bridge.js';
export {
  VIRTUAL_DEVICE_INVENTORY_BRIDGE_ID,
  createVirtualDeviceInventoryBridge,
} from './virtual-device-inventory-bridge.js';
export type {
  VirtualDeviceInventory,
  VirtualDeviceInventoryBridge,
  VirtualDeviceInventoryOptions,
  VirtualDeviceInventoryProbe,
  VirtualDeviceKind,
  VirtualDeviceRecord,
} from './virtual-device-inventory-bridge.js';
export {
  VIRTUAL_INPUT_DEVICE_INVENTORY_BRIDGE_ID,
  createVirtualInputDeviceInventoryBridge,
} from './virtual-input-device-inventory-bridge.js';
export type {
  VirtualInputDeviceInventory,
  VirtualInputDeviceInventoryBridge,
  VirtualInputDeviceInventoryOptions,
  VirtualInputDeviceInventoryProbe,
  VirtualInputDeviceKind,
  VirtualInputDeviceRecord,
} from './virtual-input-device-inventory-bridge.js';
export { VIRTUAL_CAMERA_BRIDGE_ID, createVirtualCameraBridge } from './virtual-camera-bridge.js';
export type {
  VirtualCameraBackendId,
  VirtualCameraBridge,
  VirtualCameraBridgeOptions,
  VirtualCameraBridgeProbe,
  VirtualCameraCaptureRequest,
  VirtualCameraCaptureResult,
  VirtualCameraCaptureStreamRequest,
} from './virtual-camera-bridge.js';
export {
  VIRTUAL_CAMERA_INJECTION_BRIDGE_ID,
  createVirtualCameraInjectionBridge,
} from './virtual-camera-injection-bridge.js';
export type {
  VirtualCameraInjectionBackendId,
  VirtualCameraInjectionBridge,
  VirtualCameraInjectionBridgeOptions,
  VirtualCameraInjectionHostPlan,
  VirtualCameraInjectionMode,
  VirtualCameraInjectionProbe,
  VirtualCameraInjectionRequest,
  VirtualCameraInjectionResult,
  VirtualCameraInjectionStatus,
} from './virtual-camera-injection-bridge.js';
export {
  VIRTUAL_MEDIA_DEVICE_CONTROL_BRIDGE_ID,
  createVirtualMediaDeviceControlBridge,
} from './virtual-media-device-control-bridge.js';
export type {
  VirtualMediaDeviceControlAction,
  VirtualMediaDeviceControlBridgeOptions,
  VirtualMediaDeviceControlProbe,
  VirtualMediaDeviceControlRequest,
  VirtualMediaDeviceControlResult,
  VirtualMediaDeviceControlScope,
  VirtualMediaDeviceSelection,
} from './virtual-media-device-control-bridge.js';
export {
  StubStreamingSpeechToTextBridge,
  getStreamingSttBridge,
  registerStreamingSttBridge,
} from './streaming-stt-bridge.js';
export type { StreamingSpeechToTextBridge } from './streaming-stt-bridge.js';
export {
  StubStreamingTextToSpeechBridge,
  getStreamingTtsBridge,
  registerStreamingTtsBridge,
} from './streaming-tts-bridge.js';
export type { StreamingTextToSpeechBridge } from './streaming-tts-bridge.js';
export {
  ShellStreamingSpeechToTextBridge,
  installShellStreamingSttBridge,
  installShellStreamingSttBridgeFromEnv,
} from './shell-streaming-stt-bridge.js';
export type { ShellStreamingSttOptions } from './shell-streaming-stt-bridge.js';
export {
  ShellStreamingTextToSpeechBridge,
  installShellStreamingTtsBridge,
  installShellStreamingTtsBridgeFromEnv,
} from './shell-streaming-tts-bridge.js';
export type { ShellStreamingTtsOptions } from './shell-streaming-tts-bridge.js';
export { EnergyVad, computeChunkDurationMs, computeChunkRms } from './voice-activity-detector.js';
export type {
  EnergyVadOptions,
  VoiceActivityDetector,
  VoiceActivityState,
} from './voice-activity-detector.js';
export {
  StubMeetingJoinDriver,
  getMeetingJoinDriver,
  listMeetingJoinDriversFor,
  registerMeetingJoinDriver,
  resetMeetingJoinDriverRegistry,
} from './meeting-join-driver.js';
export type { MeetingJoinDriver } from './meeting-join-driver.js';
export {
  MeetingParticipationCoordinator,
  checkMeetingParticipationConsent,
} from './meeting-participation-coordinator.js';
export type {
  ConversationAgent,
  MeetingParticipationOptions,
  MeetingParticipationReport,
} from './meeting-participation-coordinator.js';
export {
  redactMeetingUrl,
  resolveMeetingPlatform,
  resolveMeetingPlatformFromUrl,
  validateMeetingTarget,
} from './meeting-join-driver.js';
export {
  recordActionItem,
  updateActionItemStatus,
  appendReminder,
  listActionItems,
  listOperatorSelfPending,
  listOthersPending,
  listPendingSpeakerReview,
  listPartialStatePending,
  listRestrictedPending,
  clearPartialState,
  confirmActionItemBySpeaker,
  nextActionItemId,
  summarizeActionItemLifecycle,
} from './action-item-store.js';
export type {
  ActionItem,
  ActionItemAssignee,
  ActionItemAssigneeKind,
  ActionItemExecution,
  ActionItemMeetingRef,
  ActionItemModality,
  ActionItemPolicy,
  ActionItemProvenance,
  ActionItemReminder,
  ActionItemReminderRelationship,
  ActionItemReviewState,
  ActionItemStatus,
  ActionItemLifecycleSummary,
} from './action-item-store.js';
export type {
  DesignSpec,
  GateResult as SdlcGateResult,
  SaveDesignSpecParams,
  SaveTaskPlanParams,
  SaveTestPlanParams,
  TaskPlan,
  TestPlan,
} from './sdlc-artifact-store.js';
export { signA2AContent, verifyA2AContent } from './a2a-envelope-signature.js';
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
  type StubServedRecord,
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
export { runClaudeAgentQuery, ClaudeAgentQueryError } from './claude-agent-query.js';
export type { ClaudeAgentQueryParams, ClaudeAgentQueryResult } from './claude-agent-query.js';
export {
  getSpeechToTextBridge,
  getSpeechToTextBridges,
  getSpeechToTextCapabilities,
  installFluidAudioSpeechToTextBridgeIfAvailable,
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
  resetReasoningBackendPolicyCache,
} from './reasoning-backend-policy.js';
export {
  markReasoningDegraded,
  clearReasoningDegraded,
  readReasoningDegraded,
  reasoningDegradedMarkerPath,
  type ReasoningDegradedMarker,
} from './reasoning-degradation.js';
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
  resetVoiceTaskProfileCatalogCache,
} from './voice-task-profile-catalog.js';
export {
  loadMediaToneStyleMapCatalog,
  resolveMediaToneStyle,
  resetMediaToneStyleMapCatalogCache,
} from './media-tone-style-map.js';
export {
  loadMediaDrawioPolicyCatalog,
  resolveMediaDrawioBoundaryPalette,
  resolveMediaDrawioNodeSize,
  resetMediaDrawioPolicyCatalogCache,
} from './media-drawio-policy.js';
export {
  loadMediaAwsIconRuleCatalog,
  resolveMediaAwsIconCandidates,
  resetMediaAwsIconRuleCatalogCache,
} from './media-aws-icon-rules.js';
export {
  loadMediaSemanticMapCatalog,
  resolveMediaSemanticType,
  resolveProposalEvidenceIndex,
  resetMediaSemanticMapCatalogCache,
} from './media-semantic-map.js';
export {
  loadMediaStylePolicyCatalog,
  resolveSignalToneRank,
  resolveBorderKeySides,
  resetMediaStylePolicyCatalogCache,
} from './media-style-policy.js';
export {
  loadMediaSignalEntryPolicyCatalog,
  resolveMediaSignalEntryPolicy,
  resetMediaSignalEntryPolicyCatalogCache,
} from './media-signal-entry-policy.js';
export {
  loadTrackerSheetPolicyCatalog,
  resetTrackerSheetPolicyCatalogCache,
} from './tracker-sheet-policy.js';
export {
  loadMediaThemeRolePolicyCatalog,
  resolveThemeColorRole,
  resolveThemeHexRole,
  resetMediaThemeRolePolicyCatalogCache,
} from './media-theme-role-policy.js';
export {
  loadMediaDrawioEdgePolicyCatalog,
  resolveDrawioEdgeLabelStyleParts,
  resolveDrawioEdgeRoutingStyleParts,
  resetMediaDrawioEdgePolicyCatalogCache,
} from './media-drawio-edge-policy.js';
export {
  loadMediaDrawioBoundaryPolicyCatalog,
  resolveDrawioBoundaryIconCandidates,
  resolveDrawioBoundaryPaletteOverride,
  resetMediaDrawioBoundaryPolicyCatalogCache,
} from './media-drawio-boundary-policy.js';
export {
  loadMediaDrawioTierOrderCatalog,
  resolveMediaDrawioTierRank,
  resetMediaDrawioTierOrderCatalogCache,
} from './media-drawio-tier-order.js';
export {
  loadMediaDrawioSortPolicyCatalog,
  resolveMediaDrawioGroupRank,
  resolveMediaDrawioTypeRank,
  resetMediaDrawioSortPolicyCatalogCache,
} from './media-drawio-sort-policy.js';
export {
  loadMediaDrawioSecurityGroupOrderCatalog,
  resolveMediaDrawioSecurityGroupRelationPrefix,
  resetMediaDrawioSecurityGroupOrderCatalogCache,
} from './media-drawio-security-group-order.js';
export {
  loadDocumentInferencePolicyCatalog,
  resolveDocumentProfileCandidates,
  resolveDocumentProfileKeywords,
  resolveDocumentTypeFromClues,
  resetDocumentInferencePolicyCatalogCache,
} from './document-inference-policy.js';
export {
  loadDocumentContentsPolicyCatalog,
  resolveDocumentContentsLabel,
  resolveDocumentContentsSubtitle,
  resetDocumentContentsPolicyCatalogCache,
} from './document-contents-policy.js';
export {
  loadDocumentOutlineLabelPolicyCatalog,
  resolveReportSectionTitle,
  resolveReportSummaryTitle,
  resetDocumentOutlineLabelPolicyCatalogCache,
} from './document-outline-label-policy.js';
export {
  loadPromotedReportTemplatePolicyCatalog,
  resolvePromotedReportAudience,
  resolvePromotedReportOutputFormat,
  resolvePromotedReportTemplateSections,
  resetPromotedReportTemplatePolicyCatalogCache,
} from './promoted-report-template-policy.js';
export {
  loadOnboardingSummaryPolicyCatalog,
  resolveOnboardingSummaryPolicy,
  resetOnboardingSummaryPolicyCatalogCache,
} from './onboarding-summary-policy.js';
export {
  loadOnboardingFlowPolicyCatalog,
  resolveOnboardingFlowPolicy,
  resetOnboardingFlowPolicyCatalogCache,
  resolveOnboardingText,
} from './onboarding-flow-policy.js';
export type { LocalizedOnboardingText } from './onboarding-flow-policy.js';
export {
  loadMissionDistillMarkdownPolicyCatalog,
  resolveMissionDistillMarkdownPolicy,
  resetMissionDistillMarkdownPolicyCatalogCache,
} from './mission-distill-markdown-policy.js';
export {
  loadMissionLedgerPolicyCatalog,
  resolveMissionLedgerPolicy,
  resetMissionLedgerPolicyCatalogCache,
} from './mission-ledger-policy.js';
export {
  loadProviderCliCapabilityReportPolicyCatalog,
  resolveProviderCliCapabilityReportPolicy,
  resetProviderCliCapabilityReportPolicyCatalogCache,
} from './provider-cli-capability-report-policy.js';
export {
  loadMissionJournalPolicyCatalog,
  resolveMissionJournalPolicy,
  resetMissionJournalPolicyCatalogCache,
} from './mission-journal-policy.js';
export {
  loadPilotStrategyPolicyCatalog,
  resolvePilotStrategyPolicy,
  resetPilotStrategyPolicyCatalogCache,
} from './pilot-strategy-policy.js';
export {
  loadProductionEvidenceSummaryPolicyCatalog,
  resolveProductionEvidenceSummaryPolicy,
  resetProductionEvidenceSummaryPolicyCatalogCache,
} from './production-evidence-summary-policy.js';
export {
  loadChangelogPolicyCatalog,
  resolveChangelogPolicy,
  resetChangelogPolicyCatalogCache,
} from './changelog-policy.js';
export { resolveProposalSectionKeywords } from './media-semantic-map.js';
export {
  loadSpreadsheetStylePolicyCatalog,
  resolveSpreadsheetStyleIndex,
  resetSpreadsheetStylePolicyCatalogCache,
} from './spreadsheet-style-policy.js';
export {
  isLegacyMediaOp,
  loadLegacyMediaOpsCatalog,
  resetLegacyMediaOpsCatalogCache,
} from './legacy-media-ops.js';
export { installEmbeddingBackendIfAvailable } from './embedding-bootstrap.js';
export {
  getEmbeddingBackend,
  registerEmbeddingBackend,
  resetEmbeddingBackend,
  cosineSimilarity,
  reciprocalRankFusion,
} from './embedding-backend.js';
export type { EmbeddingBackend } from './embedding-backend.js';
export {
  MlxEmbeddingBackend,
  isMlxAvailable,
  probeMlxEmbeddingBackend,
} from './mlx-embedding-backend.js';
export type { MlxEmbeddingBackendOptions } from './mlx-embedding-backend.js';
export type {
  InstallAnthropicOptions,
  InstallReasoningOptions,
  ReasoningBackendMode,
} from './reasoning-bootstrap.js';
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
  PeerAdviceInput,
  PeerAdviceResult,
  GenerateWithToolsResult,
  ReasoningCallOptions,
  ToolDefinition,
  UntrustedDataParams,
} from './reasoning-backend.js';
export {
  A2ATaskContractSchema,
  PlanningPacketSchema,
  PlanningReviewVerdictSchema,
  ProcedureRankingCandidateSchema,
  ProcedureRankingSchema,
  TaskResultSchema,
  structuredOutputSchemas,
  type ProcedureRankingCandidate,
  type ProcedureRankingResult,
  type PlanningReviewVerdictResult,
  type StructuredOutputSchemaName,
  type StructuredOutputSchemaRef,
} from './structured-output-contracts.js';
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
export * from './background-review-policy.js';
export * from './background-review-curator.js';
export * from './background-review-patch.js';
export * from './background-review-runner.js';
export * from './background-review-nudge.js';
export * from './chronos-delivery.js';
export * from './automation-blueprint.js';
export * from './automation-blueprint-slack.js';
export * from './programmatic-tool-calling.js';
export * from './managed-process.js';
export * from './mission-seed-registry.js';
export * from './mission-working-memory.js';
export * from './mission-classification.js';
export * from './mission-workflow-catalog.js';
export * from './mission-process-task-expansion.js';
export * from './mission-review-gates.js';
export * from './mission-team-index.js';
export * from './delegation-preflight.js';
export * from './mission-orchestration-evaluator.js';
export * from './mission-coordination-bus.js';
export * from './mission-team-plan-composer.js';
export * from './mission-context-pack.js';
export * from './task-knowledge-provisioning.js';
export * from './cognitive-routing.js';
export * from './reasoning-drift-watchdog.js';
export * from './mission-team-binding.js';
export * from './mission-team-orchestrator.js';
export * from './agent-runtime-supervisor.js';
export * from './agent-runtime-supervisor-client.js';
export * from './mission-orchestration-events.js';
export * from './mission-orchestration-journal.js';
export * from './mission-task-recovery.js';
export * from './mission-orchestration-worker.js';
export * from './mission-task-events.js';
export * from './worker-assignment-policy.js';
export * from './pipeline-contract.js';
export * from './realtime-voice-conversation.js';
export * from './surface-coordination-store.js';
export * from './surface-delivery.js';
export * from './surface-mutation-guard.js';
export * from './ceo-surface-summary.js';
export * from './mic-capture.js';
export * from './in-room-minutes-recorder.js';
export * from './pcm-wav.js';
export * from './vad-turn-recorder.js';
export * from './audio-playback.js';
export * from './segmented-voice-playback.js';
export * from './audio-tee.js';
export * from './vad-registry.js';
export * from './silero-vad-bridge.js';
export * from './realtime-voice-loop.js';
export * from './actuator-serve-client.js';
export * from './in-room-meeting-driver.js';
export * from './chrome-extension-meeting-driver.js';
export * from './channel-directory.js';
export * from './tool-loop-guardrail.js';
export * from './surface-ingress-contract.js';
export * from './surface-interaction-model.js';
export * from './surface-ux.js';
export * from './surface-provider-manifest.js';
export * from './surface-query-overlay-catalog.js';
export * from './surface-provider-manifest-catalog.js';
export * from './surface-access-policy.js';
export * from './surface-approval-ui.js';
export * from './service-bootstrap-catalog.js';
export * from './service-onboarding-catalog.js';
export * from './surface-provider-policy.js';
export { resolveRef, handleStepError } from './src/pipeline-engine.js';
export type { OnErrorConfig, RefParams } from './src/pipeline-engine.js';
export * from './channel-surface.js';
export * from './cowork-surface.js';
export * from './cowork-knowledge-bridge.js';
export * from './cowork-health-check.js';
export * from './surface-runtime-router.js';
export * from './surface-runtime-orchestrator.js';
export * from './location-fallback.js';
export * from './surface-response-blocks.js';
export * from './surface-artifact-store.js';
export * from './surface-mission-proposals.js';
export * from './slack-approval-ui.js';
export * from './slack-onboarding.js';
export * from './agent-activity-board.js';
// Surface-level type definitions (importable without pulling in channel-surface implementation)
export type * from './channel-surface-types.js';

export * from './browser-conversation-session.js';
export * from './peer-conversation.js';
export * from './browser-distill-candidate.js';
export * from './browser-extension-bridge.js';
export * from './narrated-video-preference-profile.js';
export * from './narrated-video-upload-package.js';
export * from './meeting-operations-profile.js';
export * from './mission-seed-assessment.js';
export * from './mission-assessment.js';
export * from './task-distill-candidate.js';
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
export * from './intent-track-resolver.js';
export * from './capability-bundle-registry.js';
export * from './outcome-contract.js';
export * from './analysis-contract.js';
export * from './intent-reconciliation.js';
export * from './approval-policy.js';
export * from './router-contract.js';
export * from './analysis-intent-support.js';
export * from './intent-outcome-patterns.js';
export * from './analysis-corpus.js';
export * from './analysis-impact-bands.js';
export * from './analysis-findings.js';
export * from './analysis-execution-contract.js';
export * from './work-design.js';
export * from './productivity-task-plan.js';
export * from './booking-preference-profile.js';
export * from './presentation-preference-profile.js';
export * from './project-registry.js';
export * from './project-operational-state-registry.js';
export * from './project-track-registry.js';
export * from './sdlc-gate-readiness.js';
export * from './service-binding-registry.js';
export * from './artifact-record.js';
export * from './artifact-bundle.js';
export * from './artifact-registry.js';
export * from './control-plane-client.js';
export * from './computer-surface.js';
export * from './apple-event-bridge.js';
export * from './os-automation-bridge.js';
export * from './macos-automation-bridge.js';
export * from './os-app-adapters.js';
export * from './service-binding.js';
export * from './oauth-broker.js';
export * from './tenant-registry.js';
export * from './generation-scheduler.js';
export * from './src/pipeline-scheduler.js';
export * from './src/pipeline-preview.js';

// Governance (Agent Governance Toolkit inspired)
export * from './policy-engine.js';
export * from './trust-engine.js';
export * from './audit-chain.js';
export * from './agent-slo.js';
export * from './kill-switch.js';
export * from './subagent-capability-profiles.js';
export {
  buildBridgeErrorReplyText,
  buildBridgeEmptyReplyText,
  shouldPostBridgeError,
  resetBridgeErrorRateLimiter,
  postBridgeError,
  chunkBridgeMessage,
  chunkSurfaceMessage,
  getSurfaceCapability,
  listSurfaceCapabilities,
  isSurfaceFormatError,
  stripSurfaceMarkup,
  sendSurfaceTextWithFallback,
} from './bridge-error-reply.js';
export {
  recordConfigFallback,
  listFallbacks,
  markResolved,
  pruneResolved,
} from './config-fallback-registry.js';
export type { ConfigFallbackEntry, ConfigFallbackReason } from './config-fallback-registry.js';
export {
  recordUnclassifiedError,
  listUnclassifiedErrors,
  markReconciled as markUnclassifiedReconciled,
  pruneReconciled as pruneUnclassifiedReconciled,
} from './unclassified-error-registry.js';
export type { UnclassifiedErrorEntry } from './unclassified-error-registry.js';
export {
  recordUnhandledIntent,
  listUnhandledIntents,
  markIntentsReconciled,
  pruneReconciledIntents,
} from './unhandled-intent-registry.js';
export type { UnhandledIntentEntry, IntentMissType } from './unhandled-intent-registry.js';

// Shared Business Types
export * from './shared-business-types.js';
export * from './types.js';
// export * as visionJudge from './vision-judge.js';

// Actuator Capability Contracts (Dynamic Runtime Detection)
export {
  checkActuatorCapabilities,
  checkAllActuatorCapabilities,
  registerCapabilityProbe,
} from './src/actuator-capability.js';
export type { ActuatorCapability, ActuatorStatus } from './src/actuator-capability.js';
export {
  buildActuatorManifestIndexSnapshot,
  loadActuatorManifestCatalog,
} from './src/actuator-manifest-index.js';
export type { ActuatorCatalogEntry, ActuatorManifestFile } from './src/actuator-manifest-index.js';

// Pre-Flight Check (Sovereign Sentinel)
export * from './src/pfc/PfcController.js';
export * from './src/pfc/PhysicalLayer.js';
export * from './src/pfc/ServiceValidator.js';
export * from './src/pfc/SovereignSentinel.js';

// Observability (Unified Trace Model)
export { TraceContext, persistTrace, finalizeAndPersist, traceLogDir } from './src/trace.js';
export { createActuatorTrace, finalizeActuatorTrace } from './actuator-trace.js';
export type { Trace, TraceSpan, TraceEvent, TraceArtifact } from './src/trace.js';

// Feedback Loop (Closed-Loop Automation)
export {
  extractHintsFromTrace,
  persistHints,
  readHintsByCategory,
  checkScheduleHealth,
  recordPipelineResult,
  runFeedbackLoop,
} from './src/feedback-loop.js';

// KP-05: knowledge delivery telemetry + task_result knowledge_feedback aggregation
export {
  recordKnowledgeDelivery,
  recordKnowledgeUsageFeedback,
  loadKnowledgeUsageAggregate,
  knowledgeDeliveryLogDir,
  knowledgeUsageAggregatePath,
} from './src/knowledge-feedback-loop.js';
export type {
  DeliveredKnowledgeRef,
  KnowledgeDeliveryRecord,
  KnowledgeUsageAggregateEntry,
} from './src/knowledge-feedback-loop.js';

// JSON repair (Paper2Any pattern — lightweight structural repair before LLM escalation)
export { tryRepairJson, repairJsonString } from './json-repair.js';

// Semaphore (Paper2Any pattern — LLM concurrency guard, prevents 429 rate-limit errors)
export { Semaphore, llmSemaphore } from './semaphore.js';

// Prompt constraints (Paper2Any pattern — reusable output constraint fragments)
export {
  JSON_OUTPUT_CONSTRAINTS,
  JSON_OBJECT_CONSTRAINTS,
  JSON_ARRAY_CONSTRAINTS,
  jsonOutputConstraints,
  VALIDATOR_CHAIN_PATTERN,
} from './prompt-constraints.js';
export type { ValidatorName } from './prompt-constraints.js';

// BlackHole routing guard (SIGINT safety — restores system mic on Ctrl+C)
export {
  markRouterActive,
  markRouterInactive,
  isRouterActive,
  resetRouterSync,
} from './blackhole-routing-guard.js';

// ---------------------------------------------------------------------------
// Intent-driven automation (P0-P4) — procedure catalog, compiler, dispatcher,
// and self-repair.  All browser-execution types are in browser-extension-bridge
// (already exported above).
// ---------------------------------------------------------------------------
export type {
  ProcedureEntry,
  ProcedureCatalog,
  ProcedureSubstrate,
  ProcedureResolution,
  ProcedureDelta,
  GoldenScenario,
  GoldenSuccessCondition,
  ProcedureRiskClass,
} from './procedure-types.js';
export { PROCEDURE_RESOLUTION_THRESHOLDS } from './procedure-types.js';
export {
  loadProcedures,
  invalidateProcedureCache,
  resolveAllowlistedRecordingRef,
  resolveProcedure,
} from './procedure-registry.js';
export type { ResolveOptions } from './procedure-registry.js';
export { isDryRunSafe, compileBrowserRecording } from './browser-recording-compiler.js';
export type {
  CompiledBrowserStep,
  CompileOptions,
  CompileRecordingResult,
} from './browser-recording-compiler.js';
export { promoteBrowserProcedure } from './browser-procedure-promotion.js';
export type {
  PromoteBrowserProcedureOptions,
  PromoteBrowserProcedureResult,
} from './browser-procedure-promotion.js';
// dispatchProcedure — re-exports extendLeaseForMfa from browser-extension-bridge (already exported above)
export { dispatchProcedure } from './procedure-dispatcher.js';
export type { DispatchInput, DispatchResult, DispatchStatus } from './procedure-dispatcher.js';
export {
  classifyFailure,
  createProcedureDelta,
  saveProcedureDelta,
  loadProcedureDelta,
  suggestRepairAnchor,
  applyProcedureDelta,
} from './procedure-self-repair.js';
export { collectProcedureUserInputs } from './procedure-inputs.js';
export type { ProcedureInputField } from './procedure-inputs.js';
// Service substrate (intent-driven automation adapter)
export {
  validateServiceRecording,
  isExternalEffectStep,
  collectServiceInputNames,
} from './service-recording.js';
export type { ServiceRecording, ServiceRecordingStep } from './service-recording.js';
export { compileServiceRecording } from './service-recording-compiler.js';
export type { CompileServiceOptions, CompileServiceResult } from './service-recording-compiler.js';
export { executeServiceProcedure, resolveServiceParams } from './service-procedure-executor.js';
export type {
  ServicePresetRunner,
  ServiceStepResult,
  ExecuteServiceProcedureInput,
  ExecuteServiceProcedureResult,
} from './service-procedure-executor.js';
export { SERVICE_EXTERNAL_EFFECT_OP } from './procedure-dispatcher.js';

// KD-04: untrusted input injection framing contract
export type { FrameUntrustedInputParams } from './untrusted-input-framing.js';
export { frameUntrustedInput, UNTRUSTED_DATA_BOILERPLATE } from './untrusted-input-framing.js';

// SA-03 Prompt Injection & Untrusted Content Defense
export type { ScanOptions } from './untrusted-content.js';
export {
  wrapUntrusted,
  scanForInjection,
  scanForInjectionAsync,
  isInjectionSuspected,
  setInjectionSuspected,
  processUntrustedContent,
  processUntrustedContentAsync,
  sanitizeUntrustedContentAsync,
} from './untrusted-content.js';

// Software QA lifecycle (QA-01)
export type {
  QualityCheckStatus,
  QualityCheck,
  AcceptanceCriterion,
  QualityWaiver,
  SoftwareQualityContract,
  TestInventoryItem,
  TestInventory,
  QualityEvaluation,
  TestExecutionResult,
  TestExecutionRecord,
  DefectCandidate,
  SoftwareQualityReportSummary,
} from './software-quality.js';
export * from './software-quality-operations.js';
export {
  evaluateQualityContract,
  evaluateDefinitionOfReady,
  evaluateAcceptanceCriteria,
  evaluateDefinitionOfDone,
  evaluateTestTraceability,
  createDefectCandidates,
  buildSoftwareQualityReport,
} from './software-quality.js';
export * from './delegation-notifications.js';
