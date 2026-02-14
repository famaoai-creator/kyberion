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

import * as fs from 'node:fs';
import type { ClassifyRules, ClassifyOptions, ClassifyResult } from './types.js';

/**
 * Classify text content against a rules map.
 *
 * @param content  - Text to classify
 * @param rules    - Map of category name to keyword arrays
 * @param options  - Optional overrides for resultKey and baseConfidence
 * @returns Classification result with dynamic category key, confidence, and match count
 */
export function classify(
  content: string,
  rules: ClassifyRules,
  options: ClassifyOptions = {}
): ClassifyResult {
  const { resultKey = 'category', baseConfidence = 0.7 } = options;

  let bestCategory = 'unknown';
  let maxScore = 0;

  const totalKeywords = Math.max(...Object.values(rules).map((kw) => kw.length), 1);

  for (const [category, keywords] of Object.entries(rules)) {
    let score = 0;
    for (const word of keywords) {
      if (content.includes(word)) score++;
    }
    if (score > maxScore) {
      maxScore = score;
      bestCategory = category;
    }
  }

  const confidence =
    maxScore > 0 ? Math.min(baseConfidence + (maxScore / totalKeywords) * 0.3, 1.0) : 0;

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
export function classifyFile(
  filePath: string,
  rules: ClassifyRules,
  options: ClassifyOptions = {}
): ClassifyResult {
  const content = fs.readFileSync(filePath, 'utf8');
  return classify(content, rules, options);
}
