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
import type { ClassifyRules, ClassifyOptions, ClassifyResult } from './types.js';
/**
 * Classify text content against a rules map.
 *
 * @param content  - Text to classify
 * @param rules    - Map of category name to keyword arrays
 * @param options  - Optional overrides for resultKey and baseConfidence
 * @returns Classification result with dynamic category key, confidence, and match count
 */
export declare function classify(content: string, rules: ClassifyRules, options?: ClassifyOptions): ClassifyResult;
/**
 * Read a file from disk and classify its content.
 *
 * @param filePath - Absolute or relative path to the file
 * @param rules    - Classification rules
 * @param options  - Options forwarded to classify()
 * @returns Classification result
 */
export declare function classifyFile(filePath: string, rules: ClassifyRules, options?: ClassifyOptions): ClassifyResult;
//# sourceMappingURL=classifier.d.ts.map