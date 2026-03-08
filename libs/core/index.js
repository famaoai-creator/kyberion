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
exports.visionJudge = exports.ReflexTerminal = exports.terminalBridge = exports.say = exports.pptxUtils = exports.excelUtils = exports.orchestrator = exports.grantAccess = exports.getActiveSecrets = exports.getSecret = exports.secretGuard = exports.validateSovereignBoundary = exports.scanForConfidentialMarkers = exports.validateWritePermission = exports.validateReadPermission = exports.validateInjection = exports.canFlowTo = exports.detectTier = exports.tierGuard = exports.secureFetch = exports.classifier = exports.stringifyData = exports.parseData = exports.rootResolve = exports.resolve = exports.missionDir = exports.skillDir = exports.isProtected = exports.shared = exports.vault = exports.active = exports.scripts = exports.knowledge = exports.rootDir = exports.pathResolver = exports.isSecretPath = exports.safeStat = exports.safeReaddir = exports.safeExec = exports.safeMkdir = exports.safeUnlink = exports.safeAppendFile = exports.safeWriteFile = exports.safeReadFile = exports.secureIo = void 0;
// Core Foundation (logger, ui, sre, Cache, fileUtils, errorHandler)
__exportStar(require("./core.js"), exports);
// Specific Wrappers & Metrics
__exportStar(require("./skill-wrapper.js"), exports);
__exportStar(require("./metrics.js"), exports);
__exportStar(require("./error-codes.js"), exports);
// Secure IO & Filesystem (Shield Layer)
exports.secureIo = __importStar(require("./secure-io.js"));
var secure_io_js_1 = require("./secure-io.js");
Object.defineProperty(exports, "safeReadFile", { enumerable: true, get: function () { return secure_io_js_1.safeReadFile; } });
Object.defineProperty(exports, "safeWriteFile", { enumerable: true, get: function () { return secure_io_js_1.safeWriteFile; } });
Object.defineProperty(exports, "safeAppendFile", { enumerable: true, get: function () { return secure_io_js_1.safeAppendFile; } });
Object.defineProperty(exports, "safeUnlink", { enumerable: true, get: function () { return secure_io_js_1.safeUnlink; } });
Object.defineProperty(exports, "safeMkdir", { enumerable: true, get: function () { return secure_io_js_1.safeMkdir; } });
Object.defineProperty(exports, "safeExec", { enumerable: true, get: function () { return secure_io_js_1.safeExec; } });
const _secureIo = __importStar(require("./secure-io.js"));
exports.safeReaddir = _secureIo.safeReaddir;
exports.safeStat = _secureIo.safeStat;
exports.isSecretPath = _secureIo.isSecretPath;
// Paths & Navigation
exports.pathResolver = __importStar(require("./path-resolver.js"));
var path_resolver_js_1 = require("./path-resolver.js");
Object.defineProperty(exports, "rootDir", { enumerable: true, get: function () { return path_resolver_js_1.rootDir; } });
Object.defineProperty(exports, "knowledge", { enumerable: true, get: function () { return path_resolver_js_1.knowledge; } });
Object.defineProperty(exports, "scripts", { enumerable: true, get: function () { return path_resolver_js_1.scripts; } });
Object.defineProperty(exports, "active", { enumerable: true, get: function () { return path_resolver_js_1.active; } });
Object.defineProperty(exports, "vault", { enumerable: true, get: function () { return path_resolver_js_1.vault; } });
Object.defineProperty(exports, "shared", { enumerable: true, get: function () { return path_resolver_js_1.shared; } });
Object.defineProperty(exports, "isProtected", { enumerable: true, get: function () { return path_resolver_js_1.isProtected; } });
Object.defineProperty(exports, "skillDir", { enumerable: true, get: function () { return path_resolver_js_1.skillDir; } });
Object.defineProperty(exports, "missionDir", { enumerable: true, get: function () { return path_resolver_js_1.missionDir; } });
Object.defineProperty(exports, "resolve", { enumerable: true, get: function () { return path_resolver_js_1.resolve; } });
Object.defineProperty(exports, "rootResolve", { enumerable: true, get: function () { return path_resolver_js_1.rootResolve; } });
// Utils
__exportStar(require("./fs-utils.js"), exports);
__exportStar(require("./ledger.js"), exports);
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
// Governance & Security (Shield Layer)
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
Object.defineProperty(exports, "grantAccess", { enumerable: true, get: function () { return secret_guard_js_1.grantAccess; } });
// Orchestration
exports.orchestrator = __importStar(require("./orchestrator.js"));
// Domain Engines
exports.excelUtils = __importStar(require("./excel-utils.js"));
exports.pptxUtils = __importStar(require("./pptx-utils.js"));
// Voice & Presentation
var voice_synth_js_1 = require("./voice-synth.js");
Object.defineProperty(exports, "say", { enumerable: true, get: function () { return voice_synth_js_1.say; } });
__exportStar(require("./platform.js"), exports);
var terminal_bridge_js_1 = require("./terminal-bridge.js");
Object.defineProperty(exports, "terminalBridge", { enumerable: true, get: function () { return terminal_bridge_js_1.terminalBridge; } });
var reflex_terminal_js_1 = require("./reflex-terminal.js");
Object.defineProperty(exports, "ReflexTerminal", { enumerable: true, get: function () { return reflex_terminal_js_1.ReflexTerminal; } });
// Shared Business Types
__exportStar(require("./shared-business-types.js"), exports);
exports.visionJudge = __importStar(require("./vision-judge.js"));
