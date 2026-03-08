"use strict";
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
exports.KnowledgeProvider = void 0;
const fs = __importStar(require("node:fs"));
const pathResolver = __importStar(require("./path-resolver"));
const secure_io_1 = require("./secure-io");
/**
 * KnowledgeProvider abstracts the access to the `knowledge/` directory.
 * This allows skills to access rules, thresholds, and standards without
 * directly using the `fs` module, making testing significantly easier
 * and reducing environmental dependencies.
 */
class KnowledgeProvider {
    static mockData = {};
    static useMock = false;
    /**
     * Enable mock mode for testing.
     */
    static enableMockMode(data = {}) {
        this.useMock = true;
        this.mockData = data;
    }
    /**
     * Disable mock mode and clear mock data.
     */
    static disableMockMode() {
        this.useMock = false;
        this.mockData = {};
    }
    /**
     * Load and parse a JSON file from the knowledge directory.
     * @param relativePath Path relative to the `knowledge/` root.
     * @param defaultValue Optional default value if the file is not found.
     */
    static getJson(relativePath, defaultValue) {
        if (this.useMock) {
            if (this.mockData[relativePath] !== undefined) {
                return this.mockData[relativePath];
            }
            if (defaultValue !== undefined)
                return defaultValue;
            throw new Error(`[Mock] Knowledge file not found: ${relativePath}`);
        }
        const fullPath = pathResolver.knowledge(relativePath);
        if (!fs.existsSync(fullPath)) {
            if (defaultValue !== undefined)
                return defaultValue;
            throw new Error(`Knowledge file not found: ${fullPath}`);
        }
        try {
            const content = (0, secure_io_1.safeReadFile)(fullPath, { encoding: 'utf8' });
            return JSON.parse(content);
        }
        catch (err) {
            if (defaultValue !== undefined)
                return defaultValue;
            throw new Error(`Failed to parse Knowledge file ${relativePath}: ${err.message}`);
        }
    }
    /**
     * Read raw text content from a knowledge file.
     */
    static getText(relativePath, defaultValue) {
        if (this.useMock) {
            if (this.mockData[relativePath] !== undefined) {
                return String(this.mockData[relativePath]);
            }
            if (defaultValue !== undefined)
                return defaultValue;
            throw new Error(`[Mock] Knowledge text file not found: ${relativePath}`);
        }
        const fullPath = pathResolver.knowledge(relativePath);
        if (!fs.existsSync(fullPath)) {
            if (defaultValue !== undefined)
                return defaultValue;
            throw new Error(`Knowledge file not found: ${fullPath}`);
        }
        return (0, secure_io_1.safeReadFile)(fullPath, { encoding: 'utf8' });
    }
}
exports.KnowledgeProvider = KnowledgeProvider;
