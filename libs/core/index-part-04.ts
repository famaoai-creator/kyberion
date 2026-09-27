/** Generated public API barrel part. Keep exports in source order. */

export * from './voice/voice-selection-preferences.js';

export * from './voice/realtime-voice-preferences.js';

export * from './media/native-speech-listen-bridge.js';

export {
  AppleVisionOcrProvider,
  LlmApiOcrProvider,
  LocalVlmOcrProvider,
  TesseractOcrProvider,
  WindowsNativeOcrProvider,
  ocrImage,
  ocrImageWithRouter,
  AdaptivePolicyRouter as OcrAdaptivePolicyRouter,
} from './ocr-bridge.js';

export * from './ocr-types.js';

export * from './knowledge/knowledge-context.js';

export * from './knowledge/knowledge-adapter.js';

export * from './secret/secret-bridge.js';

export * from './secret/secret-types.js';

export * from './integrations/email-bridge.js';

export * from './integrations/email-types.js';

export * from './media/image-generation-bridge.js';

export * from './media/image-generation-types.js';

export * from './media/image-generation-policy.js';

export * from './media/music-generation-bridge.js';

export * from './media/music-generation-types.js';

export * from './media/music-generation-policy.js';

export * from './tool/tool-runtime-policy.js';

export * from './tool/tool-runtime-registry.js';
export * from './provider/provider-managed-env.js';

export * from './tool/tool-binary-resolvers.js';

export * from './service/service-runtime-policy.js';

export * from './service/service-runtime-registry.js';

export * from './service/service-pid-registry.js';

export * from './voice/voice-tts-config.js';

export * from './voice/voice-runtime-policy.js';

export * from './voice/voice-profile-registry.js';

export * from './voice/voice-transcript-alignment.js';

export * from './voice/voice-profile-promotion.js';

export * from './presentation-preference-registry.js';

export * from './imessage-bridge.js';

export * from './imessage-utils.js';

export * from './integrations/bluebubbles-adapter.js';

export * from './history-search-index.js';

export * from './voice/voice-engine-registry.js';

export * from './media/media-backend-registry.js';

export * from './actuator/adapter-default-preferences.js';

export * from './actuator/adapter-default-selection.js';

export * from './intent/intent-execution-profile-registry.js';

export * from './voice/voice-sample-ingestion-policy.js';

export * from './voice/voice-sample-collection.js';

export * from './voice/voice-sample-recorder.js';

export * from './voice/voice-text-chunking.js';

export * from './voice/voice-generation-runtime.js';

export * from './video/video-composition-contract.js';

export * from './video/video-content-brief-contract.js';

export * from './video/video-composition-template-registry.js';

export * from './video/video-render-runtime-policy.js';

export * from './video/video-render-runtime.js';

export * from './video/video-composition-compiler.js';

export * from './video/narrated-video-brief-compiler.js';

export * from './video/video-content-brief-compiler.js';

export * from './video/video-render-backend.js';

export * from './surface/surface-action-routing.js';

export * from './platform.js';

export { terminalBridge } from './shell/terminal-bridge.js';

export { ReflexTerminal } from './reflex-terminal.js';

export type { ReflexTerminalOptions } from './reflex-terminal.js';

export * from './sensor-engine.js';

export * from './sensory-memory.js';

export * from './provider/provider-capability-scanner.js';

export * from './provider/provider-capability-overview.js';

export * from './provider/provider-bridge.js';

export * from './provider/provider-permission-profiles.js';

export * from './shell/sandbox-policy.js';

export * from './permission-presets.js';

export * from './tool/tool-repeat-advisor.js';

export * from './spill-result.js';

export * from './provider/claude-task-runner.js';

export * from './provider/claude-task-session-executor.js';

export * from './actuator/actuator-op-registry.js';

export * from './stimuli-journal.js';

// Mission Status Guard

export { isValidTransition, transitionStatus } from './mission/mission-status.js';

export type { MissionStatus } from './mission/mission-status.js';

// Gate Status Guard

export { isValidGateTransition, transitionGateStatus } from './gate-status.js';

export type { GateStatus } from './gate-status.js';

// Storage Governance

export {
  scanTmp,
  rotateLogs,
  scanDataVault,
  scanRuntime,
  sweepDelegationChildren,
  runJanitor,
  runJanitorIfStale,
  readJanitorLastRunMs,
  sweepTrash,
  softDeleteToTrash,
  restoreFromTrash,
  listReviewRequiredDirs,
  scanEventStores,
  listUncoveredEventStoreDirs,
  DEFAULT_TMP_TTL_MS,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_TRASH_GRACE_DAYS,
  TRASH_REPO_SUBPATH,
} from './storage-janitor.js';

export type {
  JanitorReport,
  ScanTmpResult,
  RotateLogsResult,
  ScanDataVaultResult,
  ScanRuntimeResult,
  SweepTrashResult,
  SweepDelegationChildrenOptions,
  SweepDelegationChildrenResult,
} from './storage-janitor.js';

// Scope-linked GC & offboarding (AL-04)

export {
  gcMissionRuntimeResidue,
  offboardScope,
  collectScopeTargets,
  verifyScopeOffboarded,
  OFFBOARDING_EXPORT_SUBDIR,
  INGEST_CURSORS_REPO_SUBPATH,
  INGEST_DEDUP_REGISTRY_REPO_PATH,
} from './scope-offboarding.js';

export type {
  GcMissionRuntimeResidueResult,
  MissionResidueCandidate,
  MissionResidueProbe,
  OffboardApproval,
  OffboardDedupRegistryResult,
  OffboardScopeInput,
  PhysicalNamespaceFilter,
  OffboardScopeResult,
  OffboardScopeType,
  OffboardTarget,
  OffboardTargetKind,
  OffboardVerification,
} from './scope-offboarding.js';

// Delegation Concurrency & Wall-Clock Budget (XP-06)

export {
  withDelegationSlot,
  getDelegationConcurrencyStats,
  withWallClockBudget,
  DelegationWallClockExceededError,
  terminateAllActiveDelegationChildren,
  wireDelegationKillSwitchIntegration,
  peekPersistedDelegationChildrenRegistry,
  getRecordedDelegationTimeouts,
  UNKNOWN_DELEGATION_PROVIDER,
  DELEGATION_CHILDREN_REGISTRY_SUBPATH,
} from './mission/delegation-concurrency.js';

export {
  startDelegatedTaskTrace,
  completeDelegatedTaskTrace,
  cancelDelegatedTaskTrace,
  claimDelegatedTaskActivation,
  enqueueDelegatedTaskInbox,
  consumeDelegatedTaskInbox,
  hasPendingDelegatedTaskInbox,
  recordDelegatedTaskActivationFailure,
  recordDelegatedTaskActivationCompletion,
  createDelegationHandle,
  buildDelegatedTaskWorkerProcessSpec,
  loadDelegatedTaskRecord,
  listActiveDelegatedTaskRecords,
  resumeDelegatedTask,
  registerDelegatedTaskWorker,
  spawnDelegatedTaskWorkerProcess,
  wakeDelegatedTaskWorker,
} from './delegated-task-observability.js';

export type {
  DelegatedTaskTrace,
  DelegatedTaskRecord,
  DelegatedTaskReport,
  DelegatedTaskSettlement,
  DelegatedTaskActivationFailure,
  DelegatedTaskInboxInput,
  DelegatedTaskWorkerWake,
  DelegatedTaskWorkerHandler,
  DelegatedTaskWorkerProcessSpec,
  DelegationHandle,
} from './delegated-task-observability.js';

export type {
  DelegationSlotOptions,
  DelegationConcurrencyStats,
  DelegationConcurrencySlotStats,
  DelegationChildHandle,
  DelegationChildRecord,
  WithWallClockBudgetOptions,
  DelegationTimeoutRecord,
} from './mission/delegation-concurrency.js';

// Data Vault (external data source reference cache)

export {
  fetchWithVaultCache,
  getVaultEntry,
  invalidateVaultEntry,
  listVaultEntries,
  loadVaultEntryAtPath,
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

export type { ServicePresetCacheOptions } from './service/service-engine.js';

export { executeServicePresetCached } from './service/service-engine.js';

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
export * from './surface/a2ui-catalog.js';

export * from './headless-surface-contract.js';
export * from './surface/surface-authorization.js';

// PTY Engine (Logical Kernel)

export * from './shell/pty-engine.js';

export * from './shell/terminal-keys.js';

export * from './agent/agent-mediator.js';

export * from './mesh/acp-mediator.js';

export * from './provider/copilot-acp-reasoning-backend.js';

export * from './provider/cursor-cli-reasoning-backend.js';

export * from './provider/cursor-cli-session-adapter.js';

export * from './opencode-cli-reasoning-backend.js';

export * from './agent/agent-adapter.js';

// Agent Registry & Lifecycle

export * from './agent/agent-registry.js';

export * from './agent/agent-lifecycle.js';

export * from './agent/agent-pane-runtime-bridge.js';

export * from './agent/agent-exec-adapter-bridge.js';

export * from './voice/audio-bus-bridge.js';

export * from './browser/browser-automation-runtime-bridge.js';

export * from './meeting/calendar-provider-bridge.js';

export * from './temporal-context.js';

export * from './meeting/calendar-slot-planner.js';

export * from './mesh/a2a-bridge.js';

export * from './mesh/a2a-conversation-store.js';

export * from './agent/agent-manifest.js';

export * from './provider/provider-discovery.js';

export * from './reasoning/reasoning-endpoint-discovery.js';

export * from './provider/provider-capability-registry.js';

export * from './provider/provider-egress-gate.js';

export * from './provider/provider-backend-resolver.js'; // XP-07 close-out: real per-provider backend resolver

export * from './best-of-providers.js'; // XP-07: model-diverse best-of-N delegation

export * from './agent/agent-provider-resolution.js';

export * from './provider/provider-health-registry.js';

export * from './capability-broker.js';

export * from './tool/runtime-supervisor.js';

export * from './surface/surface-runtime.js';

export * from './organization/organization-profile.js';

export * from './organization/organization-operating-model.js';

export * from './workforce/artifact-store.js';
