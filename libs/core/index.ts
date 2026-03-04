/**
 * @agent/core - Unified Entry Point
 * All shared utilities and wrappers are centralized here.
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
  validateFileSize, 
  validateUrl,
  sanitizePath,
  writeArtifact 
} from './secure-io.js';

export * as pathResolver from './path-resolver.js';
export { 
  rootDir, 
  knowledge, 
  active, 
  scripts, 
  vault, 
  shared, 
  isProtected, 
  skillDir, 
  missionDir, 
  resolve, 
  rootResolve 
} from './path-resolver.js';
export * as pathUtils from './path-resolver.js';

// Logging, UI & Utilities
export { 
  logger, 
  ui, 
  fileUtils, 
  errorHandler, 
  Cache
} from './core.js';

// Validation & Schemas
export * from './validators.js';
export * from './validate.js';
export { getAllFiles } from './fs-utils.js';

// Error Handling
export * from './error-codes.js';

// Ledger & Auditing
export * as ledger from './ledger.js';
export { record, verifyIntegrity } from './ledger.js';

// Classification & Knowledge
export * as classifier from './classifier.js';
export * from './knowledge-provider.js';

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

// Specialized Utils
export * as excelUtils from './excel-utils.js';
export * as pptxUtils from './pptx-utils.js';
export { terminalBridge } from './terminal-bridge.js';
export { ReflexTerminal, ReflexTerminalOptions } from './reflex-terminal.js';

// Shared Business Types
export * from './shared-business-types.js';
