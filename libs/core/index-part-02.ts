/** Generated public API barrel part. Keep exports in source order. */

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
// I18N-02: type-safe rendering entry point over the namespaced vocabulary
// catalog, plus the ICU-lite message renderer it builds on.

export { t } from './t.js';

export type { VocabularyKey } from './t.js';

export { renderMessage, extractPlaceholderNames } from './message-format.js';

export type { MessageParams } from './message-format.js';

export {
  loadVocabularyCatalog,
  resolveVocabularyEntry,
  _resetVocabularyCatalogCacheForTests,
} from './vocabulary-catalog.js';

export type { VocabularyCatalogFile, VocabularyEntry } from './vocabulary-catalog.js';

export * from './operator-home-summary.js';

export { resolveActiveProfileRoot } from './profile-root.js';

export * from './browser-onboarding.js';

export { resolveOperatorDisplayName, resolveOperatorLocale } from './operator-identity.js';
// I18N-01: single source of truth for locale resolution.

export { resolveLocale, resolveDefaultLocale, normalizeLocale } from './locale.js';

export type { SupportedLocale, LocaleContext } from './locale.js';
// I18N-05: single source of truth for locale/timeZone-aware date, number,
// currency, and relative-time formatting.

export {
  formatDateTime,
  formatNumber,
  formatCurrency,
  formatRelativeTime,
  resolveTimeZone,
} from './format.js';

export type {
  DateTimeFormatStyle,
  FormatDateTimeOptions,
  FormatNumberOptions,
  FormatCurrencyOptions,
  FormatRelativeTimeOptions,
  ResolveTimeZoneContext,
} from './format.js';

export * from './company.js';

export * from './financial-model.js';

export * from './finance-controller.js';

export * from './okr-tracker.js';

export * from './decision-rights.js';

export * from './vision-resolver.js';

export * from './approval-audit.js';

export * from './org-chart.js';

export * from './daemon-heartbeat.js';

export * from './soak-restart-state.js';

export * from './soak-evidence-manifest.js';

export * from './ops-alert.js';

export * from './health-degradation.js';

export * from './aidlc-phase-state.js';

export * from './handoff-history.js';

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
  peerNetworkCatalogPath,
  listPeerEvents,
  listPeerInboxRecords,
  listPeerOutboxRecords,
  registerPeerNetworkPeer,
  persistPeerRuntimeState,
  resolvePeerRecord,
  resolvePeerNetworkCatalogPath,
  resolvePeerDispatchTarget,
  sendPeerMessage,
  sendPeerMessageToPeer,
  signPeerMessage,
  verifyPeerMessage,
} from './peer-messaging.js';

export { buildPeerBackupArtifactReferenceNotification } from './peer-backup-reference.js';

export {
  createPeerRuntimeRecoveryApprovalRequest,
  resumePeerRuntimeFromQuarantine,
  RECOVERY_APPROVAL_CHANNEL,
} from './peer-runtime-recovery.js';

export type {
  PeerRuntimeRecoveryApprovalInput,
  PeerRuntimeRecoveryResumeInput,
  PeerRuntimeRecoveryResult,
} from './peer-runtime-recovery.js';

export type {
  BuildPeerBackupArtifactReferenceInput,
  PeerBackupArtifactReference,
} from './peer-backup-reference.js';

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
  PeerNetworkCatalogVisibility,
  PeerNetworkExposure,
  PeerNetworkPeerRecord,
  RegisterPeerNetworkPeerInput,
  RegisterPeerNetworkPeerResult,
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
  loadWorkBoardCatalogAtPath,
  migrateLegacyWorkItemContexts,
  normalizeWorkItemLabels,
  releaseWorkItem,
  renewWorkItemLease,
  recordMissionHandoff,
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
  RecordMissionHandoffInput,
  ReleaseWorkItemInput,
  RenewWorkItemLeaseInput,
  UpdateWorkItemInput,
  WorkBoard,
  WorkBoardCatalog,
  WorkBoardFilter,
  WorkBoardType,
  WorkCoordinationEventType,
  WorkItem,
  WorkItemContext,
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
