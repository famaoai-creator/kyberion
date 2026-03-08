"use strict";
/**
 * TypeScript version of shared input validators for Kyberion components.
 * [SECURE-IO COMPLIANT VERSION]
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
exports.validateFilePath = validateFilePath;
exports.validateDirPath = validateDirPath;
exports.safeJsonParse = safeJsonParse;
exports.readJsonFile = readJsonFile;
exports.validateFileFreshness = validateFileFreshness;
exports.requireArgs = requireArgs;
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs")); // Still needed for low-level statSync, but we'll minimize it
const secure_io_js_1 = require("./secure-io.js");
/**
 * Validate that a file path exists and points to a regular file.
 */
function validateFilePath(filePath, label = 'input') {
    if (!filePath) {
        throw new Error(`Missing required ${label} file path`);
    }
    const resolved = path.resolve(filePath);
    // We use fs.existsSync here because safeReadFile throws if not exists, 
    // but sometimes we just want to validate without reading.
    if (!fs.existsSync(resolved)) {
        throw new Error(`File not found: ${resolved}`);
    }
    if (!fs.statSync(resolved).isFile()) {
        throw new Error(`Not a file: ${resolved}`);
    }
    return resolved;
}
/**
 * Validate that a directory path exists and points to a directory.
 */
function validateDirPath(dirPath, label = 'directory') {
    if (!dirPath) {
        throw new Error(`Missing required ${label} path`);
    }
    const resolved = path.resolve(dirPath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`Directory not found: ${resolved}`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
        throw new Error(`Not a directory: ${resolved}`);
    }
    return resolved;
}
/**
 * Safely parse a JSON string with a descriptive error message on failure.
 */
function safeJsonParse(jsonString, label = 'JSON') {
    try {
        return JSON.parse(jsonString);
    }
    catch (err) {
        throw new Error(`Invalid ${label}: ${err.message}`);
    }
}
/**
 * Read and parse a JSON file safely.
 */
function readJsonFile(filePath, label = 'JSON file') {
    const content = (0, secure_io_js_1.safeReadFile)(filePath, { encoding: 'utf8' });
    return safeJsonParse(content, label);
}
/**
 * Validate that a file is 'fresh' (modified within the last X milliseconds).
 *
 * @param filePath  - Path to the file
 * @param threshold - Maximum allowed age in milliseconds (default: 1 hour)
 * @throws {Error} If the file is older than the threshold
 */
function validateFileFreshness(filePath, threshold = 60 * 60 * 1000) {
    const resolved = validateFilePath(filePath);
    const stats = fs.statSync(resolved);
    const age = Date.now() - stats.mtimeMs;
    if (age > threshold) {
        const ageMinutes = Math.round(age / 1000 / 60);
        throw new Error(`STALE_STATE_ERROR: File at ${filePath} was last modified ${ageMinutes} minutes ago (Threshold: ${threshold / 1000 / 60} minutes). Potential cognitive drift detected.`);
    }
}
/**
 * Validate that all required arguments are present in an arguments object.
 */
function requireArgs(argv, required) {
    const missing = required.filter((name) => argv[name] === undefined || argv[name] === null);
    if (missing.length > 0) {
        throw new Error(`Missing required argument(s): ${missing.join(', ')}`);
    }
}
