/**
 * TypeScript version of the sensitivity-detector scan skill.
 *
 * Scans file content for PII patterns such as email addresses,
 * IP addresses, Japanese phone numbers, and credit card numbers.
 *
 * The CLI entry point remains in scan.cjs; this module exports
 * typed helper functions for the core scanning logic.
 *
 * Usage:
 *   import { scanContent, scanFile } from './scan.js';
 *   const result = scanContent(text);
 *   if (result.hasPII) console.warn('PII detected:', result.findings);
 */

import * as fs from 'node:fs';
import type { SkillOutput } from '../../scripts/lib/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported PII pattern category names. */
export type PIIType = 'email' | 'ipv4' | 'phone_jp' | 'credit_card';

/** Map of PII type to the number of matches found. */
export type PIIFindings = Partial<Record<PIIType, number>>;

/** Result of a sensitivity scan. */
export interface ScanResult {
  hasPII: boolean;
  findings: PIIFindings;
}

/** A named PII detection pattern. */
export interface PIIPattern {
  type: PIIType;
  regex: RegExp;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

/** Default PII detection patterns matching the CJS implementation. */
export const PII_PATTERNS: PIIPattern[] = [
  {
    type: 'email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  },
  {
    type: 'ipv4',
    regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  },
  {
    type: 'phone_jp',
    regex: /\b0\d{1,4}-\d{1,4}-\d{3,4}\b/g,
  },
  {
    type: 'credit_card',
    regex: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
  },
];

// ---------------------------------------------------------------------------
// Core scanning
// ---------------------------------------------------------------------------

/**
 * Scan text content for PII patterns.
 *
 * @param content  - Text to scan
 * @param patterns - PII patterns to use (defaults to PII_PATTERNS)
 * @returns Scan result indicating whether PII was found and match counts per type
 */
export function scanContent(content: string, patterns: PIIPattern[] = PII_PATTERNS): ScanResult {
  const findings: PIIFindings = {};
  let hasPII = false;

  for (const { type, regex } of patterns) {
    // Reset lastIndex for global regexes that may have been used before
    regex.lastIndex = 0;
    const matches = content.match(regex);
    if (matches) {
      findings[type] = matches.length;
      hasPII = true;
    }
  }

  return { hasPII, findings };
}

/**
 * Read a file and scan its content for PII patterns.
 *
 * @param filePath - Absolute or relative path to the file to scan
 * @param patterns - PII patterns to use (defaults to PII_PATTERNS)
 * @returns Scan result
 * @throws {Error} If the file cannot be read
 */
export function scanFile(filePath: string, patterns: PIIPattern[] = PII_PATTERNS): ScanResult {
  const content = fs.readFileSync(filePath, 'utf8');
  return scanContent(content, patterns);
}

/**
 * Build a SkillOutput envelope for the sensitivity-detector skill.
 *
 * @param result  - Scan result data
 * @param startMs - Start timestamp from Date.now()
 * @returns Standard SkillOutput envelope
 */
export function buildScanOutput(result: ScanResult, startMs: number): SkillOutput<ScanResult> {
  return {
    skill: 'sensitivity-detector',
    status: 'success',
    data: result,
    metadata: {
      duration_ms: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    },
  };
}
