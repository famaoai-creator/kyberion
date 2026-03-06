"use strict";
/**
 * @agent/core - Unified Entry Point
 * All shared utilities and wrappers are centralized here.
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
exports.pptxUtils = exports.excelUtils = exports.orchestrator = exports.isSecretPath = exports.getActiveSecrets = exports.getSecret = exports.secretGuard = exports.validateSovereignBoundary = exports.scanForConfidentialMarkers = exports.validateWritePermission = exports.validateReadPermission = exports.validateInjection = exports.canFlowTo = exports.detectTier = exports.tierGuard = exports.classifier = exports.verifyIntegrity = exports.record = exports.ledger = exports.getAllFiles = exports.sre = exports.Cache = exports.errorHandler = exports.fileUtils = exports.ui = exports.logger = exports.pathUtils = exports.rootResolve = exports.resolve = exports.missionDir = exports.skillDir = exports.isProtected = exports.shared = exports.vault = exports.scripts = exports.active = exports.knowledge = exports.rootDir = exports.pathResolver = exports.writeArtifact = exports.sanitizePath = exports.validateUrl = exports.validateFileSize = exports.safeExec = exports.safeMkdir = exports.safeUnlink = exports.safeAppendFile = exports.safeWriteFile = exports.safeReadFile = exports.secureIo = void 0;
exports.visionJudge = exports.ReflexTerminal = exports.terminalBridge = void 0;
// Core Wrapper & Metrics
__exportStar(require("./skill-wrapper.js"), exports);
__exportStar(require("./metrics.js"), exports);
// Secure IO & Filesystem
exports.secureIo = __importStar(require("./secure-io.js"));
var secure_io_js_1 = require("./secure-io.js");
Object.defineProperty(exports, "safeReadFile", { enumerable: true, get: function () { return secure_io_js_1.safeReadFile; } });
Object.defineProperty(exports, "safeWriteFile", { enumerable: true, get: function () { return secure_io_js_1.safeWriteFile; } });
Object.defineProperty(exports, "safeAppendFile", { enumerable: true, get: function () { return secure_io_js_1.safeAppendFile; } });
Object.defineProperty(exports, "safeUnlink", { enumerable: true, get: function () { return secure_io_js_1.safeUnlink; } });
Object.defineProperty(exports, "safeMkdir", { enumerable: true, get: function () { return secure_io_js_1.safeMkdir; } });
Object.defineProperty(exports, "safeExec", { enumerable: true, get: function () { return secure_io_js_1.safeExec; } });
Object.defineProperty(exports, "validateFileSize", { enumerable: true, get: function () { return secure_io_js_1.validateFileSize; } });
Object.defineProperty(exports, "validateUrl", { enumerable: true, get: function () { return secure_io_js_1.validateUrl; } });
Object.defineProperty(exports, "sanitizePath", { enumerable: true, get: function () { return secure_io_js_1.sanitizePath; } });
Object.defineProperty(exports, "writeArtifact", { enumerable: true, get: function () { return secure_io_js_1.writeArtifact; } });
exports.pathResolver = __importStar(require("./path-resolver.js"));
var path_resolver_js_1 = require("./path-resolver.js");
Object.defineProperty(exports, "rootDir", { enumerable: true, get: function () { return path_resolver_js_1.rootDir; } });
Object.defineProperty(exports, "knowledge", { enumerable: true, get: function () { return path_resolver_js_1.knowledge; } });
Object.defineProperty(exports, "active", { enumerable: true, get: function () { return path_resolver_js_1.active; } });
Object.defineProperty(exports, "scripts", { enumerable: true, get: function () { return path_resolver_js_1.scripts; } });
Object.defineProperty(exports, "vault", { enumerable: true, get: function () { return path_resolver_js_1.vault; } });
Object.defineProperty(exports, "shared", { enumerable: true, get: function () { return path_resolver_js_1.shared; } });
Object.defineProperty(exports, "isProtected", { enumerable: true, get: function () { return path_resolver_js_1.isProtected; } });
Object.defineProperty(exports, "skillDir", { enumerable: true, get: function () { return path_resolver_js_1.skillDir; } });
Object.defineProperty(exports, "missionDir", { enumerable: true, get: function () { return path_resolver_js_1.missionDir; } });
Object.defineProperty(exports, "resolve", { enumerable: true, get: function () { return path_resolver_js_1.resolve; } });
Object.defineProperty(exports, "rootResolve", { enumerable: true, get: function () { return path_resolver_js_1.rootResolve; } });
exports.pathUtils = __importStar(require("./path-resolver.js"));
// Logging, UI & Utilities
var core_js_1 = require("./core.js");
Object.defineProperty(exports, "logger", { enumerable: true, get: function () { return core_js_1.logger; } });
Object.defineProperty(exports, "ui", { enumerable: true, get: function () { return core_js_1.ui; } });
Object.defineProperty(exports, "fileUtils", { enumerable: true, get: function () { return core_js_1.fileUtils; } });
Object.defineProperty(exports, "errorHandler", { enumerable: true, get: function () { return core_js_1.errorHandler; } });
Object.defineProperty(exports, "Cache", { enumerable: true, get: function () { return core_js_1.Cache; } });
Object.defineProperty(exports, "sre", { enumerable: true, get: function () { return core_js_1.sre; } });
// Validation & Schemas
__exportStar(require("./validators.js"), exports);
__exportStar(require("./validate.js"), exports);
var fs_utils_js_1 = require("./fs-utils.js");
Object.defineProperty(exports, "getAllFiles", { enumerable: true, get: function () { return fs_utils_js_1.getAllFiles; } });
// Error Handling
__exportStar(require("./error-codes.js"), exports);
// Ledger & Auditing
exports.ledger = __importStar(require("./ledger.js"));
var ledger_js_1 = require("./ledger.js");
Object.defineProperty(exports, "record", { enumerable: true, get: function () { return ledger_js_1.record; } });
Object.defineProperty(exports, "verifyIntegrity", { enumerable: true, get: function () { return ledger_js_1.verifyIntegrity; } });
// Classification & Knowledge
exports.classifier = __importStar(require("./classifier.js"));
__exportStar(require("./knowledge-provider.js"), exports);
// Governance & Security
exports.tierGuard = __importStar(require("./tier-guard.js"));
var tier_guard_js_1 = require("./tier-guard.js");
Object.defineProperty(exports, "detectTier", { enumerable: true, get: function () { return tier_guard_js_1.detectTier; } });
Object.defineProperty(exports, "canFlowTo", { enumerable: true, get: function () { return tier_guard_js_1.canFlowTo; } });
Object.defineProperty(exports, "validateInjection", { enumerable: true, get: function () { return tier_guard_js_1.validateInjection; } });
Object.defineProperty(exports, "validateReadPermission", { enumerable: true, get: function () { return tier_guard_js_1.validateReadPermission; } });
Object.defineProperty(exports, "validateWritePermission", { enumerable: true, get: function () { return tier_guard_js_1.validateWritePermission; } });
Object.defineProperty(exports, "scanForConfidentialMarkers", { enumerable: true, get: function () { return tier_guard_js_1.scanForConfidentialMarkers; } });
Object.defineProperty(exports, "validateSovereignBoundary", { enumerable: true, get: function () { return tier_guard_js_1.validateSovereignBoundary; } });
exports.secretGuard = __importStar(require("./secret-guard.js"));
var secret_guard_js_1 = require("./secret-guard.js");
Object.defineProperty(exports, "getSecret", { enumerable: true, get: function () { return secret_guard_js_1.getSecret; } });
Object.defineProperty(exports, "getActiveSecrets", { enumerable: true, get: function () { return secret_guard_js_1.getActiveSecrets; } });
Object.defineProperty(exports, "isSecretPath", { enumerable: true, get: function () { return secret_guard_js_1.isSecretPath; } });
// Orchestration
exports.orchestrator = __importStar(require("./orchestrator.js"));
// Specialized Utils
exports.excelUtils = __importStar(require("./excel-utils.js"));
exports.pptxUtils = __importStar(require("./pptx-utils.js"));
var terminal_bridge_js_1 = require("./terminal-bridge.js");
Object.defineProperty(exports, "terminalBridge", { enumerable: true, get: function () { return terminal_bridge_js_1.terminalBridge; } });
var reflex_terminal_js_1 = require("./reflex-terminal.js");
Object.defineProperty(exports, "ReflexTerminal", { enumerable: true, get: function () { return reflex_terminal_js_1.ReflexTerminal; } });
// Shared Business Types
exports.visionJudge = __importStar(require("./vision-judge.js"));
//# sourceMappingURL=index.js.map