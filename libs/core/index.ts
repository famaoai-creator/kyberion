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
export { getSecret, getActiveSecrets, grantAccess, isSecretPath } from './secret-guard.js';

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
export * from './platform.js';
export { terminalBridge } from './terminal-bridge.js';
export { ReflexTerminal } from './reflex-terminal.js';
export type { ReflexTerminalOptions } from './reflex-terminal.js';
export * from './sensor-engine.js';
export * from './sensory-memory.js';
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
export * from './runtime-supervisor.js';
export * from './surface-runtime.js';
export * from './artifact-store.js';
export * from './approval-store.js';
export * from './managed-process.js';
export * from './mission-team-composer.js';
export * from './mission-team-orchestrator.js';
export * from './agent-runtime-supervisor.js';
export * from './agent-runtime-supervisor-client.js';
export * from './mission-orchestration-events.js';
export * from './mission-orchestration-worker.js';
export * from './mission-task-events.js';
export * from './pipeline-contract.js';
export { resolveRef, handleStepError } from './src/pipeline-engine.js';
export type { OnErrorConfig, RefParams } from './src/pipeline-engine.js';
export * from './channel-surface.js';
// Surface-level type definitions (importable without pulling in channel-surface implementation)
export type * from './channel-surface-types.js';

export * from './presence-surface.js';
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
export { ActuatorCapability, ActuatorStatus, checkActuatorCapabilities, checkAllActuatorCapabilities, registerCapabilityProbe } from './src/actuator-capability.js';

// Pre-Flight Check (Sovereign Sentinel)
export * from './src/pfc/PfcController.js';
export * from './src/pfc/PhysicalLayer.js';
export * from './src/pfc/ServiceValidator.js';
export * from './src/pfc/SovereignSentinel.js';

// Observability (Unified Trace Model)
export { Trace, TraceSpan, TraceEvent, TraceArtifact, TraceContext } from './src/trace.js';

// Feedback Loop (Closed-Loop Automation)
export { extractHintsFromTrace, persistHints, checkScheduleHealth, recordPipelineResult, runFeedbackLoop } from './src/feedback-loop.js';
