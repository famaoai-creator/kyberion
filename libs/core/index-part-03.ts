/** Generated public API barrel part. Keep exports in source order. */

export {
  importGitHubIssue,
  importGitHubIssueWithEvent,
  normalizeGitHubIssue,
} from './integrations/github-issues.js';

export type {
  GitHubIssueLike,
  GitHubIssueNormalizationResult,
} from './integrations/github-issues.js';

export {
  importJiraIssue,
  importJiraIssueWithEvent,
  normalizeJiraIssue,
} from './integrations/jira-issues.js';

export type { JiraIssueLike, JiraIssueNormalizationResult } from './integrations/jira-issues.js';

export {
  getWorkCoordinationImportCatalogEntryByCommand,
  listWorkCoordinationImportCatalogEntries,
  loadWorkCoordinationImportCatalog,
} from './workforce/work-coordination-import-catalog.js';

export type { WorkCoordinationImportCatalogEntry } from './workforce/work-coordination-import-catalog.js';

export {
  getActuatorDependencyBundle,
  loadActuatorDependencyBundles,
} from './actuator/actuator-dependency-bundles.js';

export type { ActuatorDependencyBundleEntry } from './actuator/actuator-dependency-bundles.js';

export {
  findSkillInstallPackageMapEntry,
  loadSkillInstallPackageMap,
} from './plugin/skill-install-package-map.js';

export type { SkillInstallPackageMapEntry } from './plugin/skill-install-package-map.js';

export {
  getServiceAuthorities,
  listServiceAuthorityMapEntries,
  loadServiceAuthorityMap,
} from './service/service-authority-map.js';

export type { ServiceAuthorityMapEntry } from './service/service-authority-map.js';

export { getSurfaceCoordinationRole } from './surface/surface-coordination-role-map.js';

export { distillPdfDesign } from './media/pdf-utils.js';

export { distillPptxDesign } from './media/pptx-utils.js';

export { distillXlsxDesign } from './media/xlsx-utils.js';

export { distillDocxDesign } from './media/docx-utils.js';

export { generateNativePptx, patchPptxText } from './media/native-pptx-engine/engine.js';

export {
  applyPptxDesignDefaults,
  resolvePptxDesignDefaults,
  designDefaultsFromMediaTheme,
  resolvePptxSurfaceDesign,
  type PptxDesignDefaults,
  type PptxDesignDefaultsInput,
} from './media/native-pptx-engine/design-cascade.js';

export type { PptxDesignProtocol, PptxElement, PptxSlide } from './contracts/pptx-protocol.js';

export {
  protocolToMarkdown,
  pdfToMarkdown,
  docxToMarkdown,
  xlsxToMarkdown,
  pptxToMarkdown,
  extractTablesFromPage,
} from './media/protocol-to-markdown.js';

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
} from './contracts/xlsx-protocol.js';

export type {
  PdfDesignProtocol,
  PdfAesthetic,
  PdfLayoutElement,
  PdfPage,
} from './contracts/pdf-protocol.js';

// Document Design Protocol (Generic Base)

export type {
  DocumentDesignProtocol,
  DocumentProvenance,
  TransformStep,
  DesignDelta,
  SemanticOf,
} from './contracts/document-protocol.js';

export {
  diffDesign,
  wrapAsPptxDocument,
  wrapAsXlsxDocument,
} from './contracts/document-protocol.js';

// Evidence Chain (Query & Summary)

// Cron Utilities

export { matchCronField, getZonedDateParts, matchesCron } from './pipeline/cron-utils.js';

export type { ZonedDateParts } from './pipeline/cron-utils.js';

// Intent Compiler

export {
  compileIntent,
  buildPipelineGenerationPrompt,
  resolveIntentToSteps,
} from './intent/intent-compiler.js';

export type { CompiledIntent } from './intent/intent-compiler.js';

export * from './intent/intent-contract.js';

export * from './intent/intent-use-case-scenario.js';

export * from './knowledge/execution-feedback.js';

export * from './intent/intent-contract-learning.js';
export * from './intent/conversation-signals.js';

export * from './intent/contextual-intent-frame.js';

export * from './intent/contextual-intent-clarification-policy.js';

export * from './intent/contextual-intent-memory.js';

export * from './intent/execution-brief.js';

export * from './tool/tool-actuator-routing.js';

export * from './mission/delegation-request.js';

export * from './intent/assistant-compiler-request.js';

export * from './intent/intent-contract.js';

export * from './mission/delegation-request.js';

export * from './intent/assistant-compiler-request.js';

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
  withExecutionContextAsync,
} from './authority.js';

export * as transformer from './pipeline/transformer.js';

export { transform, getValueByPath } from './pipeline/transformer.js';

export * as serviceEngine from './service/service-engine.js';

export {
  executeServicePreset,
  executeMcp,
  withMcpStartupAttempt,
} from './service/service-engine.js';
export type { McpApprovalContinuation } from './service/service-engine.js';

export * from './service/service-preset-registry.js';

export * from './service/service-preset-policy.js';

export * from './service/service-harness.js';

export * from './service/operator-service-connection.js';

export {
  getServiceEndpointRecord,
  loadServiceEndpointsCatalog,
  resolveServiceBinding,
} from './service/service-binding.js';

export * as secretGuard from './secret/secret-guard.js';

export {
  getSecret,
  getActiveSecrets,
  grantAccess,
  grantAccessGuarded,
  isSecretPath,
} from './secret/secret-guard.js';

export * from './shell/shell-command-policy.js';

export * from './sensitive-path-policy.js';

export * from './workforce/output-artifacts.js';

export * from './workforce/worker-context-compaction.js';

export * from './provider/completion-token-budget.js';

export * from './workforce/worker-event-stream.js';

export * from './harnessing/ce-adoption.js';

export * from './harnessing/lifecycle-hook-engine.js';

export * from './harnessing/external-hook-bridge.js';

export * from './harnessing/external-hook-discovery.js';

export * from './agent/agent-input-queue.js';

export * from './lease/writer-lease.js';

export * from './foundation/invariants.js';

export * from './plugin/plugin-contributions.js';

export * from './reasoning/dynamic-injection.js';

export * from './reasoning/prompt-cache-discipline.js';

export * from './workforce/context-rewind.js';

export * from './workforce/worker-goal.js';

export * from './workforce/worker-goal-driver.js';

export * from './agent/agent-runtime-manual-drive.js';

export * from './workforce/worker-state-journal.js';
// SO-02: durable conversation-thread <-> mission-ownership binding (own
// event-sourcing kernel; see the module docstring for the KD-03 lineage).

export * from './mission/orchestrator-session.js';
export {
  ensureMissionOwnershipWorkItem,
  migrateMissionTaskWorkItemParents,
  resolveMissionTaskParentItemId,
  type MissionOwnershipScope,
  type MissionTaskParentMigrationResult,
} from './mission/mission-ownership-item.js';
// NI-01: durable NHI registry for agent identities (journal-backed, SO-02
// pattern); AL-01 retention catalog is the storage-lifecycle counterpart.

export * from './agent/agent-identity.js';

export * from './agent/nhi-lifecycle-governance.js';

export * from './storage/storage-retention-catalog.js';

// MSN-STORE-BOUNDS-20261101: size-independent JSONL readers + shared store maintenance.
export * from './storage/jsonl-read.js';

export * from './storage/append-only-store.js';

export * from './surface/surface-steering-authority.js';

export * from './pipeline/adf-guardrails.js';

export * from './daemon/reconcile-ops.js';

export * from './daemon/report-ops.js';

export * from './contracts/execution-bounds.js';

export * from './intent/intent-handoff.js';

export * from './governance/egress-policy.js';

export * from './governance/governance-status.js';

export {
  composeMissionTeamBrief,
  writeMissionTeamBrief,
} from './mission/mission-team-brief-composer.js';

// Domain Engines (excel distiller moved to @agent/shared-media)

export * as pptxUtils from './media/pptx-utils.js';

export * as xlsxUtils from './media/xlsx-utils.js';

export * as docxUtils from './media/docx-utils.js';
// export * as finance from './finance.js';
// export * as mcpClient from './mcp-client-engine.js';

// Voice & Presentation

export * from './voice/voice-stt.js';

export * from './voice/voice-provider-adapters.js';
