/**
 * Conversational correction capture (IL-05).
 *
 * Detects natural-language standing preferences and corrections during ordinary
 * conversation (style, priority, scope boundaries) using the locale-keyed
 * `intent-phrase-lexicon.json` and records a reviewable, scope-bound
 * `MemoryCandidate` via `execution-feedback` — never mutating procedures or
 * granting authority automatically.
 */

import { segmentKeywordTerms } from '../foundation/locale-normalize.js';
import { matchesIntentPhrase } from '../intent/intent-phrase-lexicon.js';
import {
  materializeExecutionFeedbackCandidate,
  recordExecutionFeedback,
  type ExecutionFeedbackCandidate,
  type ExecutionFeedbackRecord,
} from './execution-feedback.js';
import { assertMemoryScope, type MemoryScopeEnvelope } from './memory-scope.js';

export type ConversationalCorrectionCategory =
  'style_format' | 'priority_timing' | 'scope_boundary' | 'general';

export interface ConversationalCorrectionDetection {
  matched: boolean;
  category?: ConversationalCorrectionCategory;
  normalizedRule?: string;
  confidence: 'high' | 'medium' | 'none';
}

export interface CaptureConversationalCorrectionInput {
  text: string;
  scope?: MemoryScopeEnvelope;
  intentId?: string;
  scenarioId?: string;
  correlationId?: string;
  surface?: string;
  locales?: readonly string[];
  /** Test seams. */
  recordFeedback?: typeof recordExecutionFeedback;
  materializeCandidate?: typeof materializeExecutionFeedbackCandidate;
}

export interface CaptureConversationalCorrectionResult {
  captured: boolean;
  reason: 'captured' | 'not_correction' | 'scope_required';
  detection: ConversationalCorrectionDetection;
  feedback?: ExecutionFeedbackRecord;
  candidate?: ExecutionFeedbackCandidate | null;
}

const MIN_CORRECTION_CHARS = 6;
const MAX_NORMALIZED_RULE_CHARS = 280;

const CATEGORY_CONCEPTS: ReadonlyArray<readonly [ConversationalCorrectionCategory, string]> = [
  ['scope_boundary', 'conversational_correction.scope_boundary'],
  ['priority_timing', 'conversational_correction.priority_timing'],
  ['style_format', 'conversational_correction.style_format'],
];

function hasUsableScope(scope: MemoryScopeEnvelope | undefined): scope is MemoryScopeEnvelope {
  if (!scope) return false;
  if (scope.tier === 'confidential' && !scope.tenant_slug?.trim()) return false;
  if (scope.tier === 'personal' && !scope.owner_nhi?.trim()) return false;
  try {
    assertMemoryScope(scope);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect whether an utterance expresses an actionable correction or standing
 * preference (IL-05) without hardcoded language-specific regexes in TypeScript.
 */
export function detectConversationalCorrection(
  text: string,
  options: { locales?: readonly string[] } = {}
): ConversationalCorrectionDetection {
  const normalized = String(text ?? '')
    .trim()
    .replace(/\s+/gu, ' ');
  if (normalized.length < MIN_CORRECTION_CHARS) {
    return { matched: false, confidence: 'none' };
  }

  const matchOpts = options.locales?.length ? { locales: options.locales } : undefined;
  const triggerMatched = matchesIntentPhrase(
    normalized,
    'conversational_correction.trigger',
    matchOpts
  );
  if (!triggerMatched) {
    return { matched: false, confidence: 'none' };
  }

  let matchedCategory: ConversationalCorrectionCategory | undefined;
  for (const [category, conceptId] of CATEGORY_CONCEPTS) {
    if (matchesIntentPhrase(normalized, conceptId, matchOpts)) {
      matchedCategory = category;
      break;
    }
  }

  const terms = segmentKeywordTerms(normalized);
  if (!matchedCategory && terms.length < 2) {
    return { matched: false, confidence: 'none' };
  }

  const normalizedRule =
    normalized.length > MAX_NORMALIZED_RULE_CHARS
      ? `${normalized.slice(0, MAX_NORMALIZED_RULE_CHARS - 1)}…`
      : normalized;

  return {
    matched: true,
    category: matchedCategory ?? 'general',
    normalizedRule,
    confidence: matchedCategory ? 'high' : 'medium',
  };
}

/**
 * Capture a detected conversational correction as a reviewable scoped
 * `MemoryCandidate`. Fails closed when no explicit canonical scope is present.
 */
export function captureConversationalCorrectionLearning(
  input: CaptureConversationalCorrectionInput
): CaptureConversationalCorrectionResult {
  const detection = detectConversationalCorrection(input.text, { locales: input.locales });
  if (!detection.matched || !detection.normalizedRule) {
    return { captured: false, reason: 'not_correction', detection };
  }
  if (!hasUsableScope(input.scope)) {
    return { captured: false, reason: 'scope_required', detection };
  }
  const canonicalScope = assertMemoryScope(input.scope);
  const category = detection.category ?? 'general';
  const scenarioId = input.scenarioId ?? `use-case-conversational-${category}`;
  const intentId = input.intentId ?? `conversational-correction:${category}`;

  const recordFn = input.recordFeedback ?? recordExecutionFeedback;
  const materializeFn = input.materializeCandidate ?? materializeExecutionFeedbackCandidate;

  const feedback = recordFn({
    scenario_id: scenarioId,
    intent_id: intentId,
    ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
    ...(input.surface ? { surface: input.surface } : {}),
    outcome: 'partially_satisfied',
    correction: detection.normalizedRule,
    source: 'user',
    scope: canonicalScope,
  });

  const { candidate } = materializeFn({
    feedback,
    scope: canonicalScope,
    resolvedLearningEvidence: [`conversational-correction:${category}`],
  });

  return {
    captured: true,
    reason: 'captured',
    detection,
    feedback,
    candidate,
  };
}
