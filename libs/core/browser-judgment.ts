/**
 * Judgment assist for browser automation.
 *
 * Two things a browser actuator does badly with selectors and timers, and
 * well with a bounded judgment over the page's own text.
 *
 * ## Why the page is the right input
 *
 * `browser-pipeline-helpers.ts` waits with `waitForSelector` and
 * `waitForTimeout(1000)`. Both are proxies: the first asks whether a node
 * exists, the second asks nothing at all. Neither can tell "loaded" from
 * "loaded, and it is a login wall", which is why a failed run so often
 * surfaces as a timeout on a selector that was never going to appear.
 *
 * A page's visible text answers that directly, and at 24ms on-device it can
 * be asked inside a retry loop without the cost that made it unthinkable to
 * ask a full model.
 *
 * ## Fallback, and why it differs per function
 *
 * `classifyBrowserFailure` refines `unknown` only, like error
 * classification: additive, and a heuristic verdict is never overridden.
 *
 * `judgePageReadiness` is advisory in one direction only. It may report
 * *not* ready — adding a reason to keep waiting — and it may confirm ready.
 * It must never be the only thing that says ready: the caller's selector or
 * network condition stays the gate, and this narrows the wait rather than
 * replacing it. A model that wrongly says "ready" would otherwise let a
 * pipeline act on a half-rendered page, which is exactly the silent failure
 * this seam exists to avoid.
 */

import { assistWithJudgment, choiceAnswer } from './judgment-assist.js';
import type { JudgmentQuestion } from './judgment-backend.js';
import type { TierLevel } from './types.js';

export const BROWSER_FAILURE_QUESTION = 'browser.failure_kind';
export const BROWSER_READY_QUESTION = 'browser.page_ready';

export type BrowserFailureKind =
  | 'login_required'
  | 'rate_limited'
  | 'not_found'
  | 'server_error'
  | 'consent_or_captcha'
  | 'unexpected_navigation'
  | 'element_missing'
  | 'network_failure'
  | 'unknown';

export const BROWSER_FAILURE_DESCRIPTIONS: Record<
  Exclude<BrowserFailureKind, 'unknown'>,
  string
> = {
  login_required: 'the page is asking to sign in, or the session has expired',
  rate_limited: 'the site is refusing because of rate limiting or too many requests',
  not_found: 'the page or resource does not exist',
  server_error: 'the site returned an error of its own',
  consent_or_captcha: 'a cookie banner, consent wall, or captcha is blocking the content',
  unexpected_navigation: 'the browser is somewhere other than the page that was expected',
  element_missing: 'the page is the right one but the element being acted on is not there',
  network_failure: 'the page could not be fetched at all',
};

/** Heuristics first; the judgment only fills in what these leave `unknown`. */
export function classifyBrowserFailureByRules(text: string): BrowserFailureKind {
  const value = String(text || '').toLowerCase();
  if (!value.trim()) return 'unknown';
  if (/\b(429|too many requests|rate limit)\b/.test(value)) return 'rate_limited';
  if (/\b(404|not found)\b/.test(value)) return 'not_found';
  if (/\b(5\d\d|internal server error|bad gateway|service unavailable)\b/.test(value)) {
    return 'server_error';
  }
  if (/\b(err_|net::|dns|econnrefused|etimedout)\b/.test(value)) return 'network_failure';
  if (/\b(sign in|log in|login|authenticate|session expired)\b/.test(value)) {
    return 'login_required';
  }
  if (/\b(captcha|recaptcha|are you a robot|consent|accept cookies)\b/.test(value)) {
    return 'consent_or_captcha';
  }
  if (/waiting for selector|no element matches|selector .* not found/.test(value)) {
    return 'element_missing';
  }
  return 'unknown';
}

export function browserFailureQuestion(): JudgmentQuestion {
  return {
    kind: 'choice',
    id: BROWSER_FAILURE_QUESTION,
    options: Object.keys(BROWSER_FAILURE_DESCRIPTIONS),
    optionDescriptions: BROWSER_FAILURE_DESCRIPTIONS,
    instructions:
      'A browser automation step failed. Given what the page shows, what kind of failure is this?',
  };
}

export interface BrowserJudgmentOptions {
  /** Page content is whatever the site served: personal unless told otherwise. */
  tier?: TierLevel;
  tenantSlug?: string;
  minConfidence?: number;
  timeoutMs?: number;
  /**
   * Require a fitted provider before acting on a judgment.
   *
   * **Defaults to true, from measurement rather than caution.** Evaluated on
   * twelve hand-labelled cases per call site with the Laya provider:
   *
   * | question | accuracy | above floor | of those, wrong | unstable |
   * | --- | --- | --- | --- | --- |
   * | `error.category` | 42% | 5/12 | 2 (40%) | 0 |
   * | `browser.failure_kind` | 58% | 5/12 | 1 (20%) | 0 |
   * | `knowledge.relevant` | 67% | 5/12 | 2 (40%) | 0 |
   *
   * Every site exceeded its tolerated confidently-wrong rate, and every site
   * had too few confident answers for the rate to be worth much either — so
   * both halves of `recommendRequireCalibrated` agree. Accuracy tracked
   * distance from the provider's training domain, and determinism did not:
   * 36 cases over 3 runs each produced zero disagreements while being wrong
   * a third of the time. Being deterministic is a precondition for a fit, not
   * evidence of one.
   *
   * Turning a site on is therefore a measurement landing in
   * `judgment-calibration.json`, not an edit here.
   */
  requireCalibrated?: boolean;
}

export interface BrowserFailureVerdict {
  kind: BrowserFailureKind;
  source: 'rules' | 'judgment';
  reason: string;
}

/**
 * Name a browser failure. Heuristics decide; a judgment fills in `unknown`.
 */
export async function classifyBrowserFailure(
  pageText: string,
  options: BrowserJudgmentOptions = {}
): Promise<BrowserFailureVerdict> {
  const baseline = classifyBrowserFailureByRules(pageText);
  if (baseline !== 'unknown') {
    return { kind: baseline, source: 'rules', reason: `matched a heuristic for ${baseline}` };
  }

  const result = await assistWithJudgment<BrowserFailureKind>({
    baseline,
    state: String(pageText || '').slice(0, 4_000),
    questions: [browserFailureQuestion()],
    tier: options.tier ?? 'personal',
    ...(options.tenantSlug ? { tenantSlug: options.tenantSlug } : {}),
    ...(options.minConfidence !== undefined ? { minConfidence: options.minConfidence } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    // Opt-out rather than opt-in; see the option's documentation.
    requireCalibrated: options.requireCalibrated !== false,
    label: BROWSER_FAILURE_QUESTION,
    accept(answers) {
      const answer = choiceAnswer(answers, BROWSER_FAILURE_QUESTION);
      const kind = answer?.value as BrowserFailureKind | undefined;
      if (!kind || !(kind in BROWSER_FAILURE_DESCRIPTIONS)) return undefined;
      return kind;
    },
  });

  return {
    kind: result.value,
    source: result.source === 'judgment' ? 'judgment' : 'rules',
    reason: result.reason,
  };
}

export interface PageReadinessVerdict {
  /** True only when the caller's own gate already passed. */
  ready: boolean;
  /** A judgment that the page is not ready, with its reason, if any. */
  keepWaiting: boolean;
  source: 'baseline' | 'judgment';
  reason: string;
}

/**
 * Ask whether a page looks finished, as a *second* opinion.
 *
 * `gatePassed` is the caller's deterministic condition — the selector
 * appeared, the network went idle. This can add "still not ready" on top of
 * a passed gate, and can never turn a failed gate into a pass. A model
 * cannot make the page ready; it can only notice that it is not.
 */
export async function judgePageReadiness(
  pageText: string,
  gatePassed: boolean,
  expectation: string,
  options: BrowserJudgmentOptions = {}
): Promise<PageReadinessVerdict> {
  if (!gatePassed) {
    // Nothing to add: the deterministic gate has not passed, so the answer
    // is already "keep waiting" and a judgment cannot overrule it.
    return {
      ready: false,
      keepWaiting: true,
      source: 'baseline',
      reason: 'the caller gate has not passed',
    };
  }

  const question: JudgmentQuestion = {
    kind: 'bool',
    id: BROWSER_READY_QUESTION,
    instructions:
      `期待している状態: ${expectation}\n` +
      'このページはその状態になっていますか。読み込み中、エラー、ログイン要求、' +
      '同意バナーなどで内容が出ていない場合は false。',
  };

  const result = await assistWithJudgment<{ ready: boolean }>({
    baseline: { ready: true },
    state: String(pageText || '').slice(0, 4_000),
    questions: [question],
    tier: options.tier ?? 'personal',
    ...(options.tenantSlug ? { tenantSlug: options.tenantSlug } : {}),
    ...(options.minConfidence !== undefined ? { minConfidence: options.minConfidence } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    // Opt-out rather than opt-in; see the option's documentation.
    requireCalibrated: options.requireCalibrated !== false,
    label: BROWSER_READY_QUESTION,
    accept(answers) {
      const answer = answers.find((each) => each.id === BROWSER_READY_QUESTION);
      // Only a confident "no" is actionable. A confident "yes" agrees with
      // the gate and changes nothing; anything else keeps the gate's word.
      if (answer && answer.value === false) return { ready: false };
      return undefined;
    },
  });

  const ready = result.value.ready;
  return {
    ready,
    keepWaiting: !ready,
    source: result.source,
    reason: result.reason,
  };
}
