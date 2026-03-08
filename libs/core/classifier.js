"use strict";
/**
 * TypeScript version of the keyword-based classification engine.
 *
 * Provides typed classify() and classifyFile() used by
 * doc-type-classifier, domain-classifier, intent-classifier, etc.
 *
 * Usage:
 *   import { classify, classifyFile } from '../../scripts/lib/classifier.js';
 *   const result = classify(text, rules, { resultKey: 'domain' });
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
exports.classify = classify;
exports.classifyFile = classifyFile;
const fs = __importStar(require("node:fs"));
/**
 * Classify text content against a rules map.
 *
 * @param content  - Text to classify
 * @param rules    - Map of category name to keyword arrays
 * @param options  - Optional overrides for resultKey and baseConfidence
 * @returns Classification result with dynamic category key, confidence, and match count
 */
function classify(content, rules, options = {}) {
    const { resultKey = 'category', baseConfidence = 0.7 } = options;
    let bestCategory = 'unknown';
    let maxScore = 0;
    const totalKeywords = Math.max(...Object.values(rules).map((kw) => kw.length), 1);
    for (const [category, keywords] of Object.entries(rules)) {
        let score = 0;
        for (const word of keywords) {
            if (content.includes(word))
                score++;
        }
        if (score > maxScore) {
            maxScore = score;
            bestCategory = category;
        }
    }
    const confidence = maxScore > 0 ? Math.min(baseConfidence + (maxScore / totalKeywords) * 0.3, 1.0) : 0;
    return {
        [resultKey]: bestCategory,
        confidence: Math.round(confidence * 100) / 100,
        matches: maxScore,
    };
}
/**
 * Read a file from disk and classify its content.
 *
 * @param filePath - Absolute or relative path to the file
 * @param rules    - Classification rules
 * @param options  - Options forwarded to classify()
 * @returns Classification result
 */
function classifyFile(filePath, rules, options = {}) {
    const content = fs.readFileSync(filePath, 'utf8');
    return classify(content, rules, options);
}
