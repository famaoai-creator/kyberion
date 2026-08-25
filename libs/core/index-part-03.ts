/** Generated public API barrel part. Keep exports in source order. */

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
  withExecutionContextAsync,
} from './authority.js';

export * as transformer from './transformer.js';

export { transform, getValueByPath } from './transformer.js';

export * as serviceEngine from './service-engine.js';

export { executeServicePreset, executeMcp } from './service-engine.js';

export * from './service-preset-registry.js';

export * from './service-preset-policy.js';

export * from './service-harness.js';

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

export * from './ce-adoption.js';

export * from './office-snapshot.js';

export * from './lifecycle-hook-engine.js';

export * from './external-hook-bridge.js';

export * from './external-hook-discovery.js';

export * from './agent-input-queue.js';

export * from './writer-lease.js';

export * from './invariants.js';

export * from './plugin-contributions.js';

export * from './dynamic-injection.js';

export * from './prompt-cache-discipline.js';

export * from './context-rewind.js';

export * from './worker-goal.js';

export * from './worker-goal-driver.js';

export * from './worker-state-journal.js';
// SO-02: durable conversation-thread <-> mission-ownership binding (own
// event-sourcing kernel; see the module docstring for the KD-03 lineage).

export * from './orchestrator-session.js';
// NI-01: durable NHI registry for agent identities (journal-backed, SO-02
// pattern); AL-01 retention catalog is the storage-lifecycle counterpart.

export * from './agent-identity.js';

export * from './nhi-lifecycle-governance.js';

export * from './storage-retention-catalog.js';

export * from './surface-steering-authority.js';

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
