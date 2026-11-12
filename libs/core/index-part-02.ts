/** Generated public API barrel part. Keep exports in source order. */

export type {
  BuildNextActionInput,
  ErrorNextActionContext,
  CompletionGoal,
  CompletionNextAction,
  CompletionReconciliation,
  NextAction,
  NextActionType,
} from './surface/next-action.js';

export {
  listUxStatusValues,
  renderStatus,
  renderVocabularyText,
  resolveVocabularyLocale,
  UX_STATUS_DOMAINS,
} from './localization/ux-vocabulary.js';

export type { UxStatusDomain, UxVocabularyLocale } from './localization/ux-vocabulary.js';
// I18N-02: type-safe rendering entry point over the namespaced vocabulary
// catalog, plus the ICU-lite message renderer it builds on.

export { t } from './localization/t.js';

export type { VocabularyKey } from './localization/t.js';

export { renderMessage, extractPlaceholderNames } from './foundation/message-format.js';

export type { MessageParams } from './foundation/message-format.js';

export {
  getUiMessageBundle,
  loadVocabularyCatalog,
  resolveVocabularyEntry,
  _resetVocabularyCatalogCacheForTests,
} from './knowledge/vocabulary-catalog.js';
// UI-01d: the shared UI kit's per-locale message bundle (`ui` vocabulary domain).
export { buildUiMessageBundle, UI_VOCABULARY_DOMAIN } from './foundation/locale-normalize.js';
export type { UiMessageBundle } from './foundation/locale-normalize.js';

export type { VocabularyCatalogFile, VocabularyEntry } from './knowledge/vocabulary-catalog.js';

export * from './surface/operator-home-summary.js';

export { resolveActiveProfileRoot } from './authn/profile-root.js';

export { resolveOperatorDisplayName, resolveOperatorLocale } from './surface/operator-identity.js';
// I18N-01: single source of truth for locale resolution.

export {
  resolveLocale,
  resolveDefaultLocale,
  normalizeLocale,
  deriveReplyLocale,
  resolveScopeLocale,
  enterReplyLocale,
  runWithReplyLocale,
  getReplyLocale,
  detectTextLocale,
  localeToBcp47,
  localeUsesWordSpaces,
  pickByLocale,
} from './localization/locale.js';

export type { SupportedLocale, LocaleContext } from './localization/locale.js';
// I18N-05: single source of truth for locale/timeZone-aware date, number,
// currency, and relative-time formatting.

export {
  formatDateTime,
  formatNumber,
  formatCurrency,
  formatRelativeTime,
  resolveTimeZone,
} from './localization/format.js';

export type {
  DateTimeFormatStyle,
  FormatDateTimeOptions,
  FormatNumberOptions,
  FormatCurrencyOptions,
  FormatRelativeTimeOptions,
  ResolveTimeZoneContext,
} from './localization/format.js';

export * from './organization/company.js';

export * from './localization/i18n-hardcoding-baseline.js';

export * from './knowledge/frontmatter-exclusions.js';

export * from './knowledge/knowledge-usage-aggregate.js';
export * from './knowledge/knowledge-index-cache.js';

export * from './analysis/analysis-config.js';

export * from './knowledge/knowledge-index-usage.js';

export * from './knowledge/knowledge-taxonomy.js';
export * from './knowledge/volatile-knowledge.js';

export * from './finance/financial-model.js';

export * from './finance/finance-controller.js';

export * from './finance/finance-controller-cost-report.js';

export * from './organization/okr-tracker.js';

export * from './organization/decision-rights.js';

export * from './organization/vision-resolver.js';

export * from './governance/approval-audit.js';

export * from './organization/org-chart.js';

export * from './daemon/daemon-heartbeat.js';

export * from './testing/soak-restart-state.js';

export * from './testing/soak-evidence-manifest.js';

export * from './localization/i18n-coverage-history.js';

export * from './daemon/ops-alert.js';

export * from './daemon/health-degradation.js';

export * from './mission/aidlc-phase-state.js';

export * from './mesh/handoff-history.js';

export * from './secret/secret-encryption.js';

export * from './finance/spend-guard.js';

export * from './finance/cost-report.js';

export * from './governance/chain-integrity.js';

// Classification & Knowledge

export {
  buildKnowledgeIndex,
  buildScopedIndex,
  queryKnowledge,
  queryKnowledgeHybrid,
  clearKnowledgeEmbedCache,
  KnowledgeHintIndex,
  DEFAULT_SCOPE,
  computeScopeHash,
} from './knowledge/knowledge-index.js';

export type {
  KnowledgeHint,
  KnowledgeQueryOptions,
  KnowledgeScope,
} from './knowledge/knowledge-index.js';

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
} from './mesh/peer-messaging.js';

export {
  createPeerRuntimeRecoveryApprovalRequest,
  resumePeerRuntimeFromQuarantine,
  RECOVERY_APPROVAL_CHANNEL,
} from './mesh/peer-runtime-recovery.js';

export type {
  PeerRuntimeRecoveryApprovalInput,
  PeerRuntimeRecoveryResumeInput,
  PeerRuntimeRecoveryResult,
} from './mesh/peer-runtime-recovery.js';

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
} from './mesh/peer-messaging.js';

export {
  advertiseMeshCapabilities,
  expireMeshPresence,
  listEligibleMeshPeers,
  listMeshPeerDirectoryEntries,
  recordMeshHeartbeat,
  registerMeshPeer,
  resolveMeshPeer,
} from './mesh/mesh-peer-directory.js';

export type {
  AdvertiseMeshCapabilitiesInput,
  MeshPeerDirectoryEntry,
  MeshPeerDirectoryPolicyContext,
  RecordMeshHeartbeatInput,
  RegisterMeshPeerInput,
} from './mesh/mesh-peer-directory.js';

export {
  clearMeshHubPeerMessagingAdapterNamespace,
  createMeshHubPeerMessagingAdapter,
  decideMeshHubRecipientProposal,
  listMeshHubRecipientProposals,
  MeshHubPeerMessagingAdapter,
} from './mesh/mesh-hub-peer-messaging-adapter.js';

export type {
  MeshHubPeerMessagingAdapterOptions,
  MeshHubRecipientProposalDecision,
  MeshHubRecipientProposalRecord,
  MeshHubRecipientProposalView,
} from './mesh/mesh-hub-peer-messaging-adapter.js';

export type { MeshRequest } from './mesh/mesh-hub-contract.js';

export { formatMeshHubInspectionReport, inspectMeshHub } from './mesh/mesh-hub-inspection.js';

export type {
  MeshDeadLetterRecord,
  MeshHubDeliveryInspection,
  MeshHubInspectionOptions,
  MeshHubInspectionReport,
  MeshHubPeerInspection,
} from './mesh/mesh-hub-inspection.js';

export {
  appendCoordinationEvent,
  claimWorkItem,
  clearWorkCoordinationStore,
  clearWorkCoordinationNamespace,
  createBoard,
  createDefaultWorkBoard,
  createWorkItem,
  createWorkItemIfAbsent,
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
} from './workforce/work-coordination.js';
export {
  aggregateParentStatus,
  isTopLevelWorkItem,
  issueBoardView,
  MAX_WORK_ITEM_DEPTH,
  resolveParentStatusSync,
  sharesWorkItemTenantScope,
  summarizeChildProgress,
} from './workforce/work-item-hierarchy.js';

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
} from './workforce/work-coordination.js';
