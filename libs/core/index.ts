/**
 * @agent/core - Unified Entry Point
 * All shared utilities and wrappers are centralized here.
 * [STABLE RECONSTRUCTION VERSION 2]
 */

// Core Foundation (logger, ui, sre, Cache, fileUtils, errorHandler)
export * from './core.js';

// Specific Wrappers & Metrics
export * from './skill-wrapper.js';
export * from './metrics.js';
export * from './error-codes.js';

// Secure IO & Filesystem (Shield Layer)
export * as secureIo from './secure-io.js';
export { 
  safeReadFile, 
  safeWriteFile, 
  safeAppendFile, 
  safeUnlink, 
  safeMkdir, 
  safeExec
} from './secure-io.js';

import * as _secureIo from './secure-io.js';
export const safeReaddir = (_secureIo as any).safeReaddir;
export const safeStat = (_secureIo as any).safeStat;
export const isSecretPath = (_secureIo as any).isSecretPath;

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
export * from './fs-utils.js';
export * from './ledger.js';
export { parseData, stringifyData } from './data-utils.js'; // Explicitly avoid detectFormat conflict
export * from './detectors.js';
export * from './validators.js';

// Classification & Knowledge
export * as classifier from './classifier.js';
export * from './knowledge-provider.js';

// Networking
export { secureFetch } from './network.js';

// Governance & Security (Shield Layer)
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
export { getSecret, getActiveSecrets, grantAccess } from './secret-guard.js';

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
export * from './shared-business-types.js';
export * as visionJudge from './vision-judge.js';
