/**
 * TypeScript version of the completeness-scorer skill.
 *
 * Scores document completeness by checking for empty content, TODO markers,
 * and optionally verifying the presence of required keywords from a criteria file.
 *
 * The CLI entry point remains in score.cjs; this module exports
 * typed helper functions for the core scoring logic.
 *
 * Usage:
 *   import { scoreCompleteness } from './score.js';
 *   const result = scoreCompleteness(content);
 *   const resultWithCriteria = scoreCompleteness(content, { required: ['API', 'security'] });
 */

import type { SkillOutput } from '../../scripts/lib/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Criteria configuration for completeness scoring. */
export interface CompletenessCriteria {
  /** List of keywords that must be present in the document. */
  required?: string[];
}

/** Result of completeness scoring. */
export interface CompletenessResult {
  score: number;
  issues: string[];
}

// ---------------------------------------------------------------------------
// Core scoring
// ---------------------------------------------------------------------------

/**
 * Score the completeness of document content.
 *
 * Scoring rules (matching the CJS implementation):
 * - Starts at 100
 * - Empty content: score becomes 0, adds "Content is empty" issue
 * - Each TODO marker found: -5 points
 * - Each missing required keyword (from criteria): -10 points
 * - Minimum score is clamped to 0
 *
 * @param content  - The document text to score
 * @param criteria - Optional criteria with required keywords
 * @returns Scoring result with score (0-100) and list of issues
 */
export function scoreCompleteness(
  content: string,
  criteria?: CompletenessCriteria
): CompletenessResult {
  let score = 100;
  const issues: string[] = [];

  // Check 1: Empty content
  if (!content.trim()) {
    score = 0;
    issues.push('Content is empty');
  }

  // Check 2: TODOs
  const todoCount = (content.match(/TODO/g) || []).length;
  if (todoCount > 0) {
    score -= todoCount * 5;
    issues.push(`Found ${todoCount} TODOs`);
  }

  // Check 3: Required Keywords (if criteria provided)
  if (criteria?.required) {
    criteria.required.forEach((keyword) => {
      if (!content.includes(keyword)) {
        score -= 10;
        issues.push(`Missing keyword: ${keyword}`);
      }
    });
  }

  return { score: Math.max(0, score), issues };
}

// ---------------------------------------------------------------------------
// SkillOutput builder
// ---------------------------------------------------------------------------

/**
 * Build a SkillOutput envelope for the completeness-scorer skill.
 *
 * @param result  - Completeness scoring result data
 * @param startMs - Start timestamp from Date.now()
 * @returns Standard SkillOutput envelope
 */
export function buildCompletenessOutput(
  result: CompletenessResult,
  startMs: number
): SkillOutput<CompletenessResult> {
  return {
    skill: 'completeness-scorer',
    status: 'success',
    data: result,
    metadata: {
      duration_ms: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    },
  };
}
