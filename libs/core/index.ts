/**
 * @agent/core - Unified Entry Point
 * All shared utilities and wrappers are centralized here.
 * [SECURE-IO ENFORCED VERSION]
 */

// Core Wrapper & Metrics
export * from './skill-wrapper.js';
export * from './metrics.js';

// Secure IO & Filesystem
export * as secureIo from './secure-io.js';
export { 
  safeReadFile, 
  safeWriteFile, 
  safeAppendFile, 
  safeUnlink, 
  safeMkdir, 
  safeExec,
  safeReaddir,
  safeStat,
  validateUrl,
  sanitizePath,
  writeArtifact 
} from './secure-io.js';

// Paths & Navigation
export * as pathResolver from './path-resolver.js';
export { 
  rootDir, 
  knowledge, 
  scripts, 
  active, 
  vault, 
  shared, 
  isProtected, 
  skillDir, 
  missionDir,
  resolve,
  rootResolve
} from './path-resolver.js';

// Utils
export { logger } from './logger.js';
export * as fileUtils from './file-utils.js';
export * as ui from './ui.js';
export * from './error-handler.js';
export * from './cache.js';
export * from './sre.js';
export * from './fs-utils.js';
export * from './ledger.js';
export * from './record.js';
export * from './verify-integrity.js';

// Classification & Knowledge
export * as classifier from './classifier.js';
export * from './knowledge-provider.js';

// Networking
export { secureFetch } from './network.js';

// Governance & Security
export * as tierGuard from './tier-guard.js';
export { 
  detectTier, 
  canFlowTo, 
  validateInjection, 
  validateReadPermission, 
  validateWritePermission, 
  scanForConfidentialMarkers, 
  validateSovereignBoundary 
} from './tier-guard.js';

export * as secretGuard from './secret-guard.js';
export { getSecret, getActiveSecrets, isSecretPath } from './secret-guard.js';

// Orchestration
export * as orchestrator from './orchestrator.js';

// Domain Engines
export * as excelUtils from './excel-utils.js';
export * as pptxUtils from './pptx-utils.js';

// Voice & Presentation
export { say } from './voice-synth.js';
export * from './platform.js';
export { terminalBridge } from './terminal-bridge.js';
export { ReflexTerminal, ReflexTerminalOptions } from './reflex-terminal.js';

// Shared Business Types
export * as visionJudge from './vision-judge.js';
