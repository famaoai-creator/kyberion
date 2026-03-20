"use strict";
/**
 * @agent/core - Unified Entry Point
 * All shared utilities and wrappers are centralized here.
 * [STABLE RECONSTRUCTION VERSION 2]
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateNativeXlsx = exports.generateNativePptx = exports.generateNativePdf = exports.distillDocxDesign = exports.distillXlsxDesign = exports.distillPptxDesign = exports.distillPdfDesign = exports.secureFetch = exports.classifier = exports.stringifyData = exports.parseData = exports.rootResolve = exports.resolve = exports.findMissionPath = exports.missionEvidenceDir = exports.missionDir = exports.skillDir = exports.capabilityDir = exports.capabilityEntry = exports.isProtected = exports.sharedExports = exports.sharedTmp = exports.shared = exports.capabilityAssets = exports.vault = exports.active = exports.scripts = exports.knowledge = exports.rootDir = exports.pathResolver = exports.safeUnlink = exports.safeAppendFile = exports.safeFsyncFile = exports.safeOpenAppendFile = exports.safeReadlink = exports.safeLstat = exports.safeStat = exports.safeReaddir = exports.safeExec = exports.safeExistsSync = exports.safeMkdir = exports.safeUnlinkSync = exports.safeRmSync = exports.safeSymlinkSync = exports.safeMoveSync = exports.safeCopyFileSync = exports.safeAppendFileSync = exports.safeWriteFile = exports.safeReadFile = exports.secureIo = void 0;
exports.transitionStatus = exports.isValidTransition = exports.ReflexTerminal = exports.terminalBridge = exports.say = exports.docxUtils = exports.xlsxUtils = exports.pptxUtils = exports.orchestrator = exports.isSecretPath = exports.grantAccess = exports.getActiveSecrets = exports.getSecret = exports.secretGuard = exports.validateSovereignBoundary = exports.scanForConfidentialMarkers = exports.validateWritePermission = exports.validateReadPermission = exports.detectTier = exports.tierGuard = exports.generateNativeDocx = void 0;
// Core Foundation (logger, ui, sre, Cache, fileUtils, errorHandler)
__exportStar(require("./core.js"), exports);
// Specific Wrappers & Metrics
__exportStar(require("./skill-wrapper.js"), exports);
__exportStar(require("./capability-wrapper.js"), exports);
__exportStar(require("./metrics.js"), exports);
__exportStar(require("./error-codes.js"), exports);
// Secure IO & Filesystem (Shield Layer)
exports.secureIo = __importStar(require("./secure-io.js"));
var secure_io_js_1 = require("./secure-io.js");
Object.defineProperty(exports, "safeReadFile", { enumerable: true, get: function () { return secure_io_js_1.safeReadFile; } });
Object.defineProperty(exports, "safeWriteFile", { enumerable: true, get: function () { return secure_io_js_1.safeWriteFile; } });
Object.defineProperty(exports, "safeAppendFileSync", { enumerable: true, get: function () { return secure_io_js_1.safeAppendFileSync; } });
Object.defineProperty(exports, "safeCopyFileSync", { enumerable: true, get: function () { return secure_io_js_1.safeCopyFileSync; } });
Object.defineProperty(exports, "safeMoveSync", { enumerable: true, get: function () { return secure_io_js_1.safeMoveSync; } });
Object.defineProperty(exports, "safeSymlinkSync", { enumerable: true, get: function () { return secure_io_js_1.safeSymlinkSync; } });
Object.defineProperty(exports, "safeRmSync", { enumerable: true, get: function () { return secure_io_js_1.safeRmSync; } });
Object.defineProperty(exports, "safeUnlinkSync", { enumerable: true, get: function () { return secure_io_js_1.safeUnlinkSync; } });
Object.defineProperty(exports, "safeMkdir", { enumerable: true, get: function () { return secure_io_js_1.safeMkdir; } });
Object.defineProperty(exports, "safeExistsSync", { enumerable: true, get: function () { return secure_io_js_1.safeExistsSync; } });
Object.defineProperty(exports, "safeExec", { enumerable: true, get: function () { return secure_io_js_1.safeExec; } });
Object.defineProperty(exports, "safeReaddir", { enumerable: true, get: function () { return secure_io_js_1.safeReaddir; } });
Object.defineProperty(exports, "safeStat", { enumerable: true, get: function () { return secure_io_js_1.safeStat; } });
Object.defineProperty(exports, "safeLstat", { enumerable: true, get: function () { return secure_io_js_1.safeLstat; } });
Object.defineProperty(exports, "safeReadlink", { enumerable: true, get: function () { return secure_io_js_1.safeReadlink; } });
Object.defineProperty(exports, "safeOpenAppendFile", { enumerable: true, get: function () { return secure_io_js_1.safeOpenAppendFile; } });
Object.defineProperty(exports, "safeFsyncFile", { enumerable: true, get: function () { return secure_io_js_1.safeFsyncFile; } });
// Backward compatibility aliases
var secure_io_js_2 = require("./secure-io.js");
Object.defineProperty(exports, "safeAppendFile", { enumerable: true, get: function () { return secure_io_js_2.safeAppendFileSync; } });
Object.defineProperty(exports, "safeUnlink", { enumerable: true, get: function () { return secure_io_js_2.safeUnlinkSync; } });
// Paths & Navigation
exports.pathResolver = __importStar(require("./path-resolver.js"));
var path_resolver_js_1 = require("./path-resolver.js");
Object.defineProperty(exports, "rootDir", { enumerable: true, get: function () { return path_resolver_js_1.rootDir; } });
Object.defineProperty(exports, "knowledge", { enumerable: true, get: function () { return path_resolver_js_1.knowledge; } });
Object.defineProperty(exports, "scripts", { enumerable: true, get: function () { return path_resolver_js_1.scripts; } });
Object.defineProperty(exports, "active", { enumerable: true, get: function () { return path_resolver_js_1.active; } });
Object.defineProperty(exports, "vault", { enumerable: true, get: function () { return path_resolver_js_1.vault; } });
Object.defineProperty(exports, "capabilityAssets", { enumerable: true, get: function () { return path_resolver_js_1.capabilityAssets; } });
Object.defineProperty(exports, "shared", { enumerable: true, get: function () { return path_resolver_js_1.shared; } });
Object.defineProperty(exports, "sharedTmp", { enumerable: true, get: function () { return path_resolver_js_1.sharedTmp; } });
Object.defineProperty(exports, "sharedExports", { enumerable: true, get: function () { return path_resolver_js_1.sharedExports; } });
Object.defineProperty(exports, "isProtected", { enumerable: true, get: function () { return path_resolver_js_1.isProtected; } });
Object.defineProperty(exports, "capabilityEntry", { enumerable: true, get: function () { return path_resolver_js_1.capabilityEntry; } });
Object.defineProperty(exports, "capabilityDir", { enumerable: true, get: function () { return path_resolver_js_1.capabilityDir; } });
Object.defineProperty(exports, "skillDir", { enumerable: true, get: function () { return path_resolver_js_1.skillDir; } });
Object.defineProperty(exports, "missionDir", { enumerable: true, get: function () { return path_resolver_js_1.missionDir; } });
Object.defineProperty(exports, "missionEvidenceDir", { enumerable: true, get: function () { return path_resolver_js_1.missionEvidenceDir; } });
Object.defineProperty(exports, "findMissionPath", { enumerable: true, get: function () { return path_resolver_js_1.findMissionPath; } });
Object.defineProperty(exports, "resolve", { enumerable: true, get: function () { return path_resolver_js_1.resolve; } });
Object.defineProperty(exports, "rootResolve", { enumerable: true, get: function () { return path_resolver_js_1.rootResolve; } });
// Utils
__exportStar(require("./fs-utils.js"), exports);
__exportStar(require("./cli-utils.js"), exports);
__exportStar(require("./ledger.js"), exports);
__exportStar(require("./src/logic-utils.js"), exports);
__exportStar(require("./src/lock-utils.js"), exports);
__exportStar(require("./src/retry-utils.js"), exports);
var data_utils_js_1 = require("./data-utils.js"); // Explicitly avoid detectFormat conflict
Object.defineProperty(exports, "parseData", { enumerable: true, get: function () { return data_utils_js_1.parseData; } });
Object.defineProperty(exports, "stringifyData", { enumerable: true, get: function () { return data_utils_js_1.stringifyData; } });
__exportStar(require("./detectors.js"), exports);
__exportStar(require("./validators.js"), exports);
// Classification & Knowledge
exports.classifier = __importStar(require("./classifier.js"));
__exportStar(require("./knowledge-provider.js"), exports);
// Networking
var network_js_1 = require("./network.js");
Object.defineProperty(exports, "secureFetch", { enumerable: true, get: function () { return network_js_1.secureFetch; } });
var pdf_utils_js_1 = require("./src/pdf-utils.js");
Object.defineProperty(exports, "distillPdfDesign", { enumerable: true, get: function () { return pdf_utils_js_1.distillPdfDesign; } });
var pptx_utils_js_1 = require("./src/pptx-utils.js");
Object.defineProperty(exports, "distillPptxDesign", { enumerable: true, get: function () { return pptx_utils_js_1.distillPptxDesign; } });
var xlsx_utils_js_1 = require("./src/xlsx-utils.js");
Object.defineProperty(exports, "distillXlsxDesign", { enumerable: true, get: function () { return xlsx_utils_js_1.distillXlsxDesign; } });
var docx_utils_js_1 = require("./src/docx-utils.js");
Object.defineProperty(exports, "distillDocxDesign", { enumerable: true, get: function () { return docx_utils_js_1.distillDocxDesign; } });
var engine_js_1 = require("./src/native-pdf-engine/engine.js");
Object.defineProperty(exports, "generateNativePdf", { enumerable: true, get: function () { return engine_js_1.generateNativePdf; } });
var engine_js_2 = require("./src/native-pptx-engine/engine.js");
Object.defineProperty(exports, "generateNativePptx", { enumerable: true, get: function () { return engine_js_2.generateNativePptx; } });
var engine_js_3 = require("./src/native-xlsx-engine/engine.js");
Object.defineProperty(exports, "generateNativeXlsx", { enumerable: true, get: function () { return engine_js_3.generateNativeXlsx; } });
var engine_js_4 = require("./src/native-docx-engine/engine.js");
Object.defineProperty(exports, "generateNativeDocx", { enumerable: true, get: function () { return engine_js_4.generateNativeDocx; } });
// Governance & Security (Shield Layer)
exports.tierGuard = __importStar(require("./tier-guard.js"));
var tier_guard_js_1 = require("./tier-guard.js");
Object.defineProperty(exports, "detectTier", { enumerable: true, get: function () { return tier_guard_js_1.detectTier; } });
Object.defineProperty(exports, "validateReadPermission", { enumerable: true, get: function () { return tier_guard_js_1.validateReadPermission; } });
Object.defineProperty(exports, "validateWritePermission", { enumerable: true, get: function () { return tier_guard_js_1.validateWritePermission; } });
Object.defineProperty(exports, "scanForConfidentialMarkers", { enumerable: true, get: function () { return tier_guard_js_1.scanForConfidentialMarkers; } });
Object.defineProperty(exports, "validateSovereignBoundary", { enumerable: true, get: function () { return tier_guard_js_1.validateSovereignBoundary; } });
exports.secretGuard = __importStar(require("./secret-guard.js"));
var secret_guard_js_1 = require("./secret-guard.js");
Object.defineProperty(exports, "getSecret", { enumerable: true, get: function () { return secret_guard_js_1.getSecret; } });
Object.defineProperty(exports, "getActiveSecrets", { enumerable: true, get: function () { return secret_guard_js_1.getActiveSecrets; } });
Object.defineProperty(exports, "grantAccess", { enumerable: true, get: function () { return secret_guard_js_1.grantAccess; } });
Object.defineProperty(exports, "isSecretPath", { enumerable: true, get: function () { return secret_guard_js_1.isSecretPath; } });
// Orchestration
exports.orchestrator = __importStar(require("./orchestrator.js"));
// Domain Engines (Moved to @agent/shared-*)
// export * as excelUtils from './excel-utils.js';
exports.pptxUtils = __importStar(require("./src/pptx-utils.js"));
exports.xlsxUtils = __importStar(require("./src/xlsx-utils.js"));
exports.docxUtils = __importStar(require("./src/docx-utils.js"));
// export * as finance from './finance.js';
// export * as mcpClient from './mcp-client-engine.js';
// Voice & Presentation
var voice_synth_js_1 = require("./voice-synth.js");
Object.defineProperty(exports, "say", { enumerable: true, get: function () { return voice_synth_js_1.say; } });
__exportStar(require("./platform.js"), exports);
var terminal_bridge_js_1 = require("./terminal-bridge.js");
Object.defineProperty(exports, "terminalBridge", { enumerable: true, get: function () { return terminal_bridge_js_1.terminalBridge; } });
var reflex_terminal_js_1 = require("./reflex-terminal.js");
Object.defineProperty(exports, "ReflexTerminal", { enumerable: true, get: function () { return reflex_terminal_js_1.ReflexTerminal; } });
__exportStar(require("./sensor-engine.js"), exports);
__exportStar(require("./sensory-memory.js"), exports);
__exportStar(require("./stimuli-journal.js"), exports);
// Mission Status Guard
var mission_status_1 = require("./mission-status");
Object.defineProperty(exports, "isValidTransition", { enumerable: true, get: function () { return mission_status_1.isValidTransition; } });
Object.defineProperty(exports, "transitionStatus", { enumerable: true, get: function () { return mission_status_1.transitionStatus; } });
// A2UI Protocol
__exportStar(require("./a2ui"), exports);
// PTY Engine (Logical Kernel)
__exportStar(require("./pty-engine"), exports);
__exportStar(require("./terminal-keys"), exports);
__exportStar(require("./agent-mediator"), exports);
__exportStar(require("./acp-mediator"), exports);
__exportStar(require("./agent-adapter"), exports);
// Agent Registry & Lifecycle
__exportStar(require("./agent-registry"), exports);
__exportStar(require("./agent-lifecycle"), exports);
__exportStar(require("./a2a-bridge"), exports);
__exportStar(require("./agent-manifest"), exports);
__exportStar(require("./provider-discovery"), exports);
__exportStar(require("./runtime-supervisor"), exports);
__exportStar(require("./surface-runtime"), exports);
__exportStar(require("./artifact-store"), exports);
__exportStar(require("./approval-store"), exports);
__exportStar(require("./managed-process"), exports);
__exportStar(require("./mission-team-composer"), exports);
__exportStar(require("./mission-team-orchestrator"), exports);
__exportStar(require("./agent-runtime-supervisor"), exports);
__exportStar(require("./mission-orchestration-events"), exports);
__exportStar(require("./mission-orchestration-worker"), exports);
__exportStar(require("./mission-task-events"), exports);
__exportStar(require("./pipeline-contract"), exports);
__exportStar(require("./channel-surface"), exports);
__exportStar(require("./service-binding"), exports);
// Governance (Agent Governance Toolkit inspired)
__exportStar(require("./policy-engine"), exports);
__exportStar(require("./trust-engine"), exports);
__exportStar(require("./audit-chain"), exports);
__exportStar(require("./agent-slo"), exports);
__exportStar(require("./kill-switch"), exports);
// Shared Business Types
__exportStar(require("./shared-business-types.js"), exports);
// export * as visionJudge from './vision-judge.js';
//# sourceMappingURL=index.js.map