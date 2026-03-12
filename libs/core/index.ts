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
  safeAppendFileSync, 
  safeUnlinkSync, 
  safeMkdir, 
  safeExistsSync, 
  safeExec,
  safeReaddir,
  safeStat
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
  shared, 
  isProtected, 
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

// Classification & Knowledge
export * as classifier from './classifier.js';
export * from './knowledge-provider.js';

// Networking
export { secureFetch } from './network.js';
export { distillPdfDesign } from './src/pdf-utils.js';
export { generateNativePdf } from './src/native-pdf-engine/engine.js';
export { generateNativePptx } from './src/native-pptx-engine/engine.js';

// Governance & Security (Shield Layer)
export * as tierGuard from './tier-guard.js';
export { 
  detectTier, 
  validateReadPermission, 
  validateWritePermission, 
  scanForConfidentialMarkers, 
  validateSovereignBoundary 
} from './tier-guard.js';

export * as secretGuard from './secret-guard.js';
export { getSecret, getActiveSecrets, grantAccess, isSecretPath } from './secret-guard.js';

// Orchestration
export * as orchestrator from './orchestrator.js';

// Domain Engines (Moved to @agent/shared-*)
// export * as excelUtils from './excel-utils.js';
// export * as pptxUtils from './pptx-utils.js';
// export * as finance from './finance.js';
// export * as mcpClient from './mcp-client-engine.js';

// Voice & Presentation
export { say } from './voice-synth.js';
export * from './platform.js';
export { terminalBridge } from './terminal-bridge.js';
export { ReflexTerminal, ReflexTerminalOptions } from './reflex-terminal.js';
export * from './sensor-engine.js';
export * from './sensory-memory.js';

// Shared Business Types
export * from './shared-business-types.js';
// export * as visionJudge from './vision-judge.js';

