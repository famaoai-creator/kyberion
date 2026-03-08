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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectEncoding = detectEncoding;
exports.detectLanguage = detectLanguage;
exports.detectFormat = detectFormat;
const fs = __importStar(require("node:fs"));
const jschardet = __importStar(require("jschardet"));
const languagedetect_1 = __importDefault(require("languagedetect"));
const lngDetector = new languagedetect_1.default();
/**
 * Detects file encoding and line endings.
 */
function detectEncoding(bufferOrPath) {
    const buffer = Buffer.isBuffer(bufferOrPath) ? bufferOrPath : fs.readFileSync(bufferOrPath);
    const result = jschardet.detect(buffer);
    const content = buffer.toString();
    let lineEnding = 'unknown';
    if (content.includes('\r\n'))
        lineEnding = 'CRLF';
    else if (content.includes('\n'))
        lineEnding = 'LF';
    else if (content.includes('\r'))
        lineEnding = 'CR';
    return { ...result, lineEnding };
}
/**
 * Detects natural language of text.
 */
function detectLanguage(text) {
    const results = lngDetector.detect(text, 1);
    if (results.length > 0) {
        return { language: results[0][0], confidence: results[0][1] };
    }
    return { language: 'unknown', confidence: 0 };
}
/**
 * Detects data format (json, yaml, csv).
 */
function detectFormat(text) {
    let format = 'unknown';
    let confidence = 0.0;
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            JSON.parse(trimmed);
            return { format: 'json', confidence: 1.0 };
        }
        catch (_) { }
    }
    if (trimmed.includes('---') || trimmed.includes(': ')) {
        format = 'yaml';
        confidence = 0.7;
    }
    else if (trimmed.includes(',')) {
        const lines = trimmed.split('\n');
        if (lines.length > 0 && lines[0].split(',').length > 1) {
            format = 'csv';
            confidence = 0.6;
        }
    }
    return { format, confidence };
}
