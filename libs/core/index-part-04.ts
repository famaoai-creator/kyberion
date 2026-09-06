/** Generated public API barrel part. Keep exports in source order. */

export * from './voice-selection-preferences.js';

export * from './native-speech-listen-bridge.js';

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

export * from './service-pid-registry.js';

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

export * from './sandbox-policy.js';

export * from './permission-presets.js';

export * from './tool-repeat-advisor.js';

export * from './spill-result.js';

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
} from './delegation-concurrency.js';

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
} from './delegation-concurrency.js';

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

export * from './headless-surface-contract.js';
export * from './surface-authorization.js';

// PTY Engine (Logical Kernel)

export * from './pty-engine.js';

export * from './terminal-keys.js';

export * from './agent-mediator.js';

export * from './acp-mediator.js';

export * from './copilot-acp-reasoning-backend.js';

export * from './cursor-cli-reasoning-backend.js';

export * from './opencode-cli-reasoning-backend.js';

export * from './agent-adapter.js';

// Agent Registry & Lifecycle

export * from './agent-registry.js';

export * from './agent-lifecycle.js';

export * from './a2a-bridge.js';

export * from './a2a-conversation-store.js';

export * from './agent-manifest.js';

export * from './provider-discovery.js';

export * from './reasoning-endpoint-discovery.js';

export * from './provider-capability-registry.js';

export * from './provider-egress-gate.js';

export * from './provider-backend-resolver.js'; // XP-07 close-out: real per-provider backend resolver

export * from './best-of-providers.js'; // XP-07: model-diverse best-of-N delegation

export * from './agent-provider-resolution.js';

export * from './provider-health-registry.js';

export * from './capability-broker.js';

export * from './runtime-supervisor.js';

export * from './surface-runtime.js';

export * from './organization-profile.js';

export * from './organization-operating-model.js';

export * from './artifact-store.js';
