/**
 * @agent/core - Unified Entry Point
 * All shared utilities and wrappers are centralized here.
 */

// Core Wrapper & Metrics
export * from './skill-wrapper.js';
export * from './metrics.js';

// Secure IO & Filesystem
export * from './secure-io.js';
export { pathResolver } from './path-resolver.js';
export * as pathUtils from './path-resolver.js';

// Logging & UI
export { logger, ui, fileUtils, errorHandler } from './core.js';

// Validation & Schemas
export * from './validators.js';
export * from './validate.js';

// Classification & Knowledge
export * as classifier from './classifier.js';
export * from './knowledge-provider.js';

// Governance & Security
export * as tierGuard from './tier-guard.js';
export * from './tier-guard.js';
export * as secretGuard from './secret-guard.js';

// Orchestration
export * as orchestrator from './orchestrator.js';

// Specialized Utils
export * as excelUtils from './excel-utils.js';
export * as pptxUtils from './pptx-utils.js';
export { terminalBridge } from './terminal-bridge.js';

// Shared Business Types
export * from './shared-business-types.js';
