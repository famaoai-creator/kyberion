/**
 * Judgment assist for error classification.
 *
 * `classifyError()` stays exactly as it is: synchronous, rule-driven,
 * authoritative. This adds an async path that runs **only when the rules
 * returned `unknown`**, which makes the integration strictly additive — a
 * judgment can turn "no rule matched" into a category, and can never
 * override a category a rule already decided. If no model is available, or
 * it is slow, or unsure, the result is byte-identical to `classifyError()`.
 *
 * ## Why this call site first
 *
 * Every other candidate needs a labelled corpus built by hand. This one
 * accumulates its own: `recordUnclassifiedError()` writes each unmatched
 * error to `unclassified-error-registry.json` with an occurrence count, from
 * real traffic. That is the ingredient calibration needs and a synthetic
 * bench cannot supply — measured error, weighted by how often it actually
 * happens.
 *
 * It was not quite a corpus, though: the registry recorded *that* an entry
 * had been reconciled and not *to what*, so the inputs accumulated without
 * labels. `markReconciled()` now takes the category it was resolved to, and
 * `exportErrorJudgmentCorpus()` reads the registry back out as fit input —
 * labelled where reconciled, and a queue to label where not.
 */

import {
  classifyError,
  type ErrorCategory,
  type ErrorClassification,
} from './error-classifier.js';
import { assistWithJudgment, choiceAnswer } from './judgment-assist.js';
import { listUnclassifiedErrors } from './unclassified-error-registry.js';
import type { JudgmentQuestion } from './judgment-backend.js';
import type { TierLevel } from './types.js';

export const ERROR_CATEGORY_QUESTION = 'error.category';

/**
 * One sentence per category. Measured on this seam, options described only
 * by their identifiers cost most of the accuracy, so these are part of the
 * contract rather than documentation.
 */
export const ERROR_CATEGORY_DESCRIPTIONS: Record<Exclude<ErrorCategory, 'unknown'>, string> = {
  auth: 'credentials are missing, expired, or rejected',
  permission_denied: 'the caller is not allowed to do this, by policy or by OS permissions',
  network: 'the network failed: DNS, TCP, TLS, or an HTTP timeout',
  rate_limit: 'the provider refused because a quota or rate limit was hit',
  missing_dependency: 'a required binary or package is not installed',
  missing_secret: 'an expected environment variable or keychain entry is absent',
  invalid_input: 'the input was malformed: bad JSON, a schema violation, a broken contract',
  resource_unavailable: 'a resource is taken or exhausted: a port in use, a locked file, a full disk',
  timeout: 'the operation ran past its time limit',
  governance_block: 'a governance policy refused it, or an approval is required first',
  tier_violation: 'the data tier guard refused the access',
  mission_not_found: 'a mission id could not be resolved',
};

export function errorCategoryQuestion(): JudgmentQuestion {
  return {
    kind: 'choice',
    id: ERROR_CATEGORY_QUESTION,
    options: Object.keys(ERROR_CATEGORY_DESCRIPTIONS),
    optionDescriptions: ERROR_CATEGORY_DESCRIPTIONS,
    instructions:
      'This is an error produced by an automation system. Which kind of failure is it?',
  };
}

export interface AssistedErrorClassification extends ErrorClassification {
  /** Where the category came from; `ruleId` is 'judgment' when refined. */
  source: 'rules' | 'judgment';
  /** Deterministic explanation, including why a judgment was declined. */
  judgment_reason?: string;
}

export interface ClassifyErrorAssistedOptions {
  /** Tier of the error text. Errors can quote paths and payloads: default personal. */
  tier?: TierLevel;
  tenantSlug?: string;
  minConfidence?: number;
  timeoutMs?: number;
  /** Refuse any provider without a fit. Off by default; nothing is fitted yet. */
  requireCalibrated?: boolean;
}

/**
 * `classifyError()` plus a judgment for the errors it could not place.
 *
 * Defaults to `personal` tier because error text routinely quotes file
 * paths, hostnames and payload fragments. That confines it to a declared
 * local-only provider, and to the baseline when there is none.
 */
export async function classifyErrorAssisted(
  err: unknown,
  options: ClassifyErrorAssistedOptions = {}
): Promise<AssistedErrorClassification> {
  const baseline = classifyError(err);
  if (baseline.category !== 'unknown') {
    // A matched rule is never second-guessed.
    return { ...baseline, source: 'rules' };
  }

  const result = await assistWithJudgment<ErrorClassification>({
    baseline,
    state: baseline.detail,
    questions: [errorCategoryQuestion()],
    tier: options.tier ?? 'personal',
    ...(options.tenantSlug ? { tenantSlug: options.tenantSlug } : {}),
    ...(options.minConfidence !== undefined ? { minConfidence: options.minConfidence } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.requireCalibrated ? { requireCalibrated: true } : {}),
    label: ERROR_CATEGORY_QUESTION,
    accept(answers, current) {
      const answer = choiceAnswer(answers, ERROR_CATEGORY_QUESTION);
      const category = answer?.value as ErrorCategory | undefined;
      // Only a category the rules know about, and never 'unknown' — an
      // answer outside the enum is a provider bug, not a classification.
      if (!category || !(category in ERROR_CATEGORY_DESCRIPTIONS)) return undefined;
      return {
        ...current,
        category,
        label: `${current.label} (judged ${category})`,
        remediation: ERROR_CATEGORY_DESCRIPTIONS[category as keyof typeof ERROR_CATEGORY_DESCRIPTIONS],
        ruleId: 'judgment',
      };
    },
  });

  return {
    ...result.value,
    source: result.source === 'judgment' ? 'judgment' : 'rules',
    judgment_reason: result.reason,
  };
}

export interface ErrorJudgmentCorpusItem {
  message_excerpt: string;
  code?: string;
  occurrence_count: number;
  first_seen: string;
  last_seen: string;
  /** Assigned when the entry is reconciled; absent means unlabelled. */
  expected_category?: ErrorCategory;
}

/**
 * The accumulated unmatched errors, as calibration-fit input.
 *
 * Unreconciled entries are unlabelled and are the queue to label; reconciled
 * ones carry the category they were resolved to. Weighted by
 * `occurrence_count`, this is a frequency-realistic sample rather than an
 * even one, which is what a fit for this call site should see.
 */
export function exportErrorJudgmentCorpus(): ErrorJudgmentCorpusItem[] {
  const entries = listUnclassifiedErrors();
  return entries.map((entry) => ({
    message_excerpt: entry.message_excerpt,
    ...(entry.code ? { code: entry.code } : {}),
    occurrence_count: entry.occurrence_count,
    first_seen: entry.first_seen,
    last_seen: entry.last_seen,
    ...(entry.reconciled && entry.reconciled_category
      ? { expected_category: entry.reconciled_category as ErrorCategory }
      : {}),
  }));
}
