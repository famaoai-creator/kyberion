/**
 * MSN-HARNESS-ADOPT R1: live backend conformance scenarios.
 *
 * `backend-conformance.ts` exercises only what costs no model turn
 * (binary / version / --help), so `session_continuity` and `abort` stayed
 * declarations. This module drives a real `ReasoningBackend` through short
 * scenarios and records what the backend actually did, so those declarations
 * can be checked against a measurement (`backend-capability-honesty.ts`).
 *
 * Judging rules (each one closes a way a scenario could pass on nothing):
 * - A verdict is read from the backend's RETURNED ANSWER, never from the
 *   prompt text: every prompt of the form "Reply with exactly: M1-x" contains
 *   the word being checked for, so a check that sees the prompt passes always.
 *   The word must be the answer (or sit in a short one); an answer that
 *   repeats the prompt is an echo and fails.
 * - A follow-up answer that still carries the first turn's word is a replayed
 *   transcript (stale/echo), not a fresh answer, and fails.
 * - `fail` is only a judged wrong answer or observed misbehaviour. A thrown
 *   error or timeout (rate limit, auth, network) is `unreported`: it says
 *   nothing about the capability, and must not become a standing contradiction.
 * - `unreported` means the outcome could not be determined (error, empty
 *   answer, unreadable workspace, a delegation that settled before it could be
 *   aborted, a turn another mode served). It is never counted as a pass.
 * - When `first` does not pass, nothing after it measured anything, so the
 *   remaining scenarios are `not_run` rather than failures; reset_continue is
 *   also `not_run` unless follow_up showed continuity to lose.
 * - A failing or unreported scenario is retried once; the first attempt's
 *   outcome is kept in `first_try`, so a flaky pass stays visible. An abort
 *   that ignored the signal is never retried: that delegation is still running.
 * - abort is judged on the provider's own promise after the AbortSignal, not
 *   on the delegation handle's state (see scenarioAbort). A rejection carrying
 *   the scenario's own abort reason was answered by a wrapper that forwarded
 *   the signal, not by the provider, and is `unreported`.
 * - Measure the provider, not the request wrapper: build the backend with
 *   `requestTimeout: 'caller'` (see check_backend_live_scenarios.ts). The
 *   route wrapper races every call against the caller signal and the route
 *   timeout, so through it abort reflects the wrapper and long turns hit the
 *   route's 60s ceiling instead of `turnTimeoutMs`.
 * - `served_model` is what the caller can prove the provider served; absent
 *   that evidence it is `'unreported'`, never the requested model.
 *
 * Every run spends real model turns. Nothing here runs in CI: tests drive a
 * deterministic stub backend and the operator entrypoint
 * (`scripts/check_backend_live_scenarios.ts`) refuses to run without `--live`.
 */

import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { logger } from './core.js';
import { nowIso } from './foundation/time.js';
import { readJsonIfPresent, writeJson } from './foundation/json.js';
import * as pathResolver from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
} from './secure-io.js';
import { createScratchWorkspace, deleteRegisteredWorkspace } from './workforce/workspace-ledger.js';
import type { ReasoningBackend } from './reasoning/reasoning-backend-contracts.js';
import {
  classifyMeasuredAbortRejection,
  measurementAbortReason,
} from './reasoning/reasoning-abort-measurement.js';
import { delegationAbortChildExit } from './mission/delegation-concurrency.js';

export const LIVE_SCENARIO_NAMES = [
  'first',
  'follow_up',
  'reset_continue',
  'abort',
  'artifact',
] as const;
export type LiveScenarioName = (typeof LIVE_SCENARIO_NAMES)[number];

export type LiveScenarioOutcome = 'pass' | 'fail' | 'not_run' | 'unreported';

export interface LiveScenarioResult {
  scenario: LiveScenarioName;
  outcome: LiveScenarioOutcome;
  /** Present when the scenario was retried: the outcome of the first attempt. */
  first_try?: LiveScenarioOutcome;
  attempts: number;
  /** Why this outcome — the sentence a reader of a failing row needs. */
  detail: string;
  /** Tail of the backend's own answer (never the prompt), for audit. */
  answer_excerpt?: string;
  duration_ms: number;
  /** Serving modes sampled during the final attempt, when the caller supplies servedMode. */
  served_modes?: string[];
  /** reset_continue only: what the backend remembered after resetSession(). */
  continuity_after_reset?: 'lost' | 'retained' | 'unreported';
  /**
   * follow_up only: what the recall turn showed. Only the recall turn decides
   * continuity; a follow_up that failed on the M2 instruction turn (echo,
   * replay, non-compliance) never reached it and records `'unreported'`.
   */
  continuity?: 'held' | 'absent' | 'unreported';
}

export interface BackendLiveScenarioRecord {
  version: '1.0.0';
  run_id: string;
  /** Reasoning mode under test (the governed mode id). */
  mode: string;
  /** `ReasoningBackend.name` of the instance that was driven. */
  backend_name: string;
  model_requested?: string;
  /** Model the provider proved it served; `'unreported'` when unproven. */
  served_model: string;
  /**
   * Last mode the reasoning chain reported serving. Per-scenario samples live
   * in `served_modes`; a scenario any turn of which another mode served is
   * scored `unreported`.
   */
  served_mode?: string;
  started_at: string;
  finished_at: string;
  scenarios: LiveScenarioResult[];
}

export interface LiveScenarioWorkspace {
  path: string;
  release(): void;
}

export interface RunBackendLiveScenariosOptions {
  mode: string;
  model?: string;
  /** Deterministic nonce for tests; random per run otherwise. */
  nonce?: string;
  runId?: string;
  now?: () => string;
  /** Per-turn ceiling for prompt/delegate calls. */
  turnTimeoutMs?: number;
  /** Grace window for an aborted delegation to stop after the abort signal. */
  abortTimeoutMs?: number;
  /** Delay between starting the long delegation and cancelling it. */
  abortStartDelayMs?: number;
  /**
   * Abort passes only when the adapter observed its child process exit
   * (default true). Set false only for a backend with no child process
   * (API providers), where the provider's abort error is the whole evidence.
   */
  requireChildExit?: boolean;
  /** Retries for a failing scenario (default 1). */
  retries?: number;
  /** Evidence of the served model, when the caller has any. */
  servedModel?: () => string | undefined;
  /** Evidence of the served mode (e.g. the chain's last-served marker), sampled after every call. */
  servedMode?: () => string | undefined;
  /** Test seam: scratch workspace for the artifact scenario. */
  createWorkspace?: () => LiveScenarioWorkspace;
  /** Test seam: file reads for the artifact check. */
  readFile?: (file: string) => string | undefined;
}

/**
 * Default per-turn ceiling. The operator entrypoint builds its backend with
 * `requestTimeout: 'caller'` and this as `timeoutMs`, so neither the route's
 * request wrapper nor a shorter provider limit undercuts it.
 */
export const BACKEND_LIVE_TURN_TIMEOUT_MS = 180_000;
const DEFAULT_TURN_TIMEOUT_MS = BACKEND_LIVE_TURN_TIMEOUT_MS;
const DEFAULT_ABORT_TIMEOUT_MS = 30_000;
const DEFAULT_ABORT_START_DELAY_MS = 1_000;
const EXCERPT_CHARS = 200;

class ScenarioTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ScenarioTimeoutError(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function excerpt(answer: string): string {
  return answer.length > EXCERPT_CHARS ? answer.slice(-EXCERPT_CHARS) : answer;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

type Attempt = Omit<LiveScenarioResult, 'scenario' | 'attempts' | 'first_try' | 'duration_ms'>;

interface ScenarioContext {
  backend: ReasoningBackend;
  options: RunBackendLiveScenariosOptions;
  words: { m1: string; m2: string; m3: string };
  nonce: string;
  turn: (prompt: string) => Promise<string>;
  /** Serving modes sampled during the current attempt (see servedMode). */
  servedModes: Set<string>;
  sampleServedMode: () => void;
}

const RECALL_PROMPT =
  'What exact word did I ask you to reply with in my very first message of this conversation? Reply with just that word.';

/** Opening of RECALL_PROMPT: an answer carrying it copied the prompt. */
const RECALL_PROMPT_HEAD = 'What exact word did I ask you';

/** How much text besides the word an answer may carry and still count as "the word". */
const WORD_ANSWER_SLACK_CHARS = 40;

/** Looser cap for the recall answer, whose prompt cannot leak the word. */
const RECALL_ANSWER_SLACK_CHARS = 240;

/**
 * Prompt-echo markers. An answer that repeats the instruction has not been
 * shown to comply — it copied the prompt, which already contains the word.
 */
const PROMPT_ECHO_PATTERN = /reply with (?:exactly|just)|first message of this conversation/iu;

export type WordJudgement = 'word' | 'echo' | 'absent';

const LEADING_DECORATION = new Set([...'"\'`*.:']);
const TRAILING_DECORATION = new Set([...'"\'`*.:!']);

/**
 * Trim whitespace and quote/punctuation decoration from both ends. A linear
 * scan, not an anchored regex: `[…]+$` retries from every position and runs
 * quadratically on long whitespace runs in untrusted model output.
 */
function stripAnswerDecoration(answer: string): string {
  const isSpace = (ch: string) => ch.trim() === '';
  let start = 0;
  let end = answer.length;
  while (start < end && (isSpace(answer[start]) || LEADING_DECORATION.has(answer[start]))) start++;
  while (end > start && (isSpace(answer[end - 1]) || TRAILING_DECORATION.has(answer[end - 1])))
    end--;
  return answer.slice(start, end);
}

/**
 * Judge an answer against the requested word, from the answer alone. The word
 * must BE the answer (after trimming quotes/punctuation) or sit in a short
 * answer; an answer that repeats the prompt is an echo, never a pass.
 */
export function judgeWordAnswer(answer: string, word: string): WordJudgement {
  if (PROMPT_ECHO_PATTERN.test(answer)) return 'echo';
  const stripped = stripAnswerDecoration(answer);
  if (stripped === word) return 'word';
  if (answer.includes(word) && answer.trim().length <= word.length + WORD_ANSWER_SLACK_CHARS) {
    return 'word';
  }
  return 'absent';
}

/**
 * Ask one turn. A thrown error or timeout (rate limit, auth, network) says
 * nothing about the capability, so it is `unreported`, never `fail`; a blank
 * answer is likewise something we cannot judge.
 */
async function askForWord(
  ctx: ScenarioContext,
  prompt: string
): Promise<{ answer: string } | Attempt> {
  let answer: string;
  try {
    answer = await ctx.turn(prompt);
  } catch (error) {
    return { outcome: 'unreported', detail: `the turn errored, not judged: ${errorText(error)}` };
  } finally {
    ctx.sampleServedMode();
  }
  if (typeof answer !== 'string' || answer.trim() === '') {
    return { outcome: 'unreported', detail: 'the backend returned an empty answer' };
  }
  return { answer };
}

function echoAttempt(answer: string): Attempt {
  return {
    outcome: 'fail',
    detail: 'the answer repeats the prompt instead of answering it',
    answer_excerpt: excerpt(answer),
  };
}

async function scenarioFirst(ctx: ScenarioContext): Promise<Attempt> {
  const { m1 } = ctx.words;
  const reply = await askForWord(ctx, `Reply with exactly: ${m1}`);
  if (!('answer' in reply)) return reply;
  const judged = judgeWordAnswer(reply.answer, m1);
  if (judged === 'echo') return echoAttempt(reply.answer);
  return {
    outcome: judged === 'word' ? 'pass' : 'fail',
    detail: judged === 'word' ? `answered ${m1}` : `answered without ${m1}`,
    answer_excerpt: excerpt(reply.answer),
  };
}

async function scenarioFollowUp(ctx: ScenarioContext): Promise<Attempt> {
  const { m1, m2 } = ctx.words;
  const reply = await askForWord(ctx, `Reply with exactly: ${m2}`);
  if (!('answer' in reply)) return reply;
  // Failures on this instruction turn are misbehaviour, not evidence about
  // continuity: the recall turn that decides it was never asked.
  if (reply.answer.includes(m1)) {
    return {
      outcome: 'fail',
      detail: `the follow-up repeats the first turn's answer (${m1}): stale or replayed transcript`,
      answer_excerpt: excerpt(reply.answer),
      continuity: 'unreported',
    };
  }
  const judged = judgeWordAnswer(reply.answer, m2);
  if (judged === 'echo') return { ...echoAttempt(reply.answer), continuity: 'unreported' };
  if (judged !== 'word') {
    return {
      outcome: 'fail',
      detail: `the follow-up answered without ${m2}`,
      answer_excerpt: excerpt(reply.answer),
      continuity: 'unreported',
    };
  }
  const recall = await askForWord(ctx, RECALL_PROMPT);
  if (!('answer' in recall)) return { ...recall, continuity: 'unreported' };
  // The recall prompt does not contain M1, so an echo of it cannot produce the
  // word: a verbose but correct recall ("you asked for M1-…") is a pass. The
  // strict judgeWordAnswer stays on the "Reply with exactly" turns, whose
  // prompt does carry the word.
  const ok =
    recall.answer.includes(m1) &&
    recall.answer.trim().length <= m1.length + RECALL_ANSWER_SLACK_CHARS;
  return {
    outcome: ok ? 'pass' : 'fail',
    detail: ok
      ? `answered ${m2} fresh, then recalled ${m1}: session continuity held`
      : `answered ${m2} but did not recall ${m1}: no session continuity`,
    answer_excerpt: excerpt(recall.answer),
    continuity: ok ? 'held' : 'absent',
  };
}

async function scenarioResetContinue(ctx: ScenarioContext): Promise<Attempt> {
  if (typeof ctx.backend.resetSession !== 'function') {
    return { outcome: 'not_run', detail: 'the backend exposes no resetSession()' };
  }
  try {
    await ctx.backend.resetSession();
  } catch (error) {
    return {
      outcome: 'unreported',
      detail: `resetSession() errored, not judged: ${errorText(error)}`,
      continuity_after_reset: 'unreported',
    };
  }
  const { m1, m3 } = ctx.words;
  const fresh = await askForWord(ctx, `Reply with exactly: ${m3}`);
  if (!('answer' in fresh)) return { ...fresh, continuity_after_reset: 'unreported' };
  const freshJudged = judgeWordAnswer(fresh.answer, m3);
  if (freshJudged === 'echo') {
    return { ...echoAttempt(fresh.answer), continuity_after_reset: 'unreported' };
  }
  if (freshJudged !== 'word') {
    return {
      outcome: 'fail',
      detail: `after resetSession() the backend answered without ${m3}: it cannot continue`,
      answer_excerpt: excerpt(fresh.answer),
      continuity_after_reset: 'unreported',
    };
  }
  const recall = await askForWord(ctx, RECALL_PROMPT);
  if (!('answer' in recall)) return { ...recall, continuity_after_reset: 'unreported' };
  if (recall.answer.includes(RECALL_PROMPT_HEAD)) {
    // A copy of the recall prompt proves nothing about what the session still
    // holds. (A verbose answer that merely mentions "your first message" is
    // still an answer.)
    return {
      outcome: 'unreported',
      detail: 'the post-reset recall answer repeats the prompt, so retention cannot be judged',
      answer_excerpt: excerpt(recall.answer),
      continuity_after_reset: 'unreported',
    };
  }
  const retained = recall.answer.includes(m1);
  return {
    outcome: retained ? 'fail' : 'pass',
    detail: retained
      ? `after resetSession() the backend still recalled ${m1}: the reset did not drop session state`
      : `after resetSession() the backend continued (${m3}) and no longer recalled ${m1}`,
    answer_excerpt: excerpt(recall.answer),
    continuity_after_reset: retained ? 'retained' : 'lost',
  };
}

type AbortSettlement = { kind: 'resolved' } | { kind: 'rejected'; error: unknown };

/**
 * Abort is measured below the handle. Every `delegateTaskHandle` in the repo
 * is `createDelegationHandle`, whose `cancel()` marks the record cancelled and
 * makes `join()` refuse the result whether or not the provider stopped — the
 * handle's terminal state is true by construction and proves nothing. What
 * decides whether work stops is whether the provider honours the AbortSignal
 * the handle forwards to `delegateTask`, so this drives that same call with
 * its own signal and watches the provider's own promise:
 * - rejects with an abort error within the grace window AND the adapter
 *   observed its child process exit (`DelegationAbortedError`'s
 *   `child_exit=exited`) → pass. A CLI adapter's rejection alone proves only
 *   that it started stopping; `withWallClockBudget` now waits (bounded:
 *   SIGTERM, grace, SIGKILL, grace) for the exit before rejecting. Backends
 *   with no child process (API providers) are driven with
 *   `requireChildExit: false`, where the abort error alone passes;
 * - the child survived SIGKILL (`child_exit=not_exited`) → fail;
 * - an abort error with no observed exit while `requireChildExit` is on →
 *   unreported;
 * - still running after the grace window → fail (the signal was ignored);
 * - settled before the abort, resolved after it, or rejected for another
 *   reason → unreported (abort was not shown either way).
 * A provider-side kill callback (`createDelegationHandle`'s `cancel` input)
 * is not observable through the handle; no provider supplies one today.
 * `delegateTaskHandle` presence still gates the scenario: without it the
 * backend offers callers no cancel surface at all.
 */
async function scenarioAbort(ctx: ScenarioContext): Promise<Attempt> {
  if (typeof ctx.backend.delegateTaskHandle !== 'function') {
    return { outcome: 'not_run', detail: 'the backend exposes no delegateTaskHandle()' };
  }
  const graceMs = ctx.options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
  const controller = new AbortController();
  let settlement: AbortSettlement | undefined;
  let observed: Promise<void>;
  try {
    observed = ctx.backend
      .delegateTask(
        'Count slowly from 1 to 10000, one number per line, explaining each number in a full paragraph. Do not stop early.',
        undefined,
        { signal: controller.signal, ...(ctx.options.model ? { model: ctx.options.model } : {}) }
      )
      .then(
        () => {
          settlement = { kind: 'resolved' };
        },
        (error: unknown) => {
          settlement = { kind: 'rejected', error };
        }
      );
  } catch (error) {
    return {
      outcome: 'unreported',
      detail: `delegateTask() errored, not judged: ${errorText(error)}`,
    };
  }
  await delay(ctx.options.abortStartDelayMs ?? DEFAULT_ABORT_START_DELAY_MS);
  ctx.sampleServedMode();
  const before = settlement as AbortSettlement | undefined;
  if (before) {
    return {
      outcome: 'unreported',
      detail: `the delegation ${before.kind} before it could be aborted, so abort was not exercised`,
    };
  }
  const reason = measurementAbortReason('backend-live-scenario', ctx.nonce);
  controller.abort(reason);
  try {
    await withTimeout(observed, graceMs, 'aborted delegation');
  } catch {
    // Still pending after the grace window.
  }
  const after = settlement as AbortSettlement | undefined;
  if (!after) {
    return {
      outcome: 'fail',
      detail: `the provider was still running ${graceMs}ms after the abort signal: it ignored the signal`,
    };
  }
  const rejection =
    after.kind === 'rejected' ? classifyMeasuredAbortRejection(after.error, reason) : undefined;
  if (rejection === 'forwarded') {
    return {
      outcome: 'unreported',
      detail:
        'the rejection is the caller signal reason forwarded by a wrapper, not the provider stopping; drive the backend without the request-timeout wrapper',
    };
  }
  if (rejection === 'abort') {
    const childExit = delegationAbortChildExit(after.kind === 'rejected' ? after.error : undefined);
    if (childExit === 'exited') {
      return {
        outcome: 'pass',
        detail:
          'the provider rejected with an abort error after its child process was observed to exit, within the grace window',
      };
    }
    if (childExit === 'not_exited') {
      return {
        outcome: 'fail',
        detail:
          'the adapter signalled its child process but it was still running after SIGKILL: the work did not stop',
      };
    }
    if (ctx.options.requireChildExit !== false) {
      return {
        outcome: 'unreported',
        detail:
          'the provider rejected with an abort error but reported no observed child process exit, so stopping was not shown (an adapter that only started stopping is not a pass)',
      };
    }
    return {
      outcome: 'pass',
      detail: 'the provider stopped and rejected with an abort error within the grace window',
    };
  }
  return {
    outcome: 'unreported',
    detail:
      after.kind === 'resolved'
        ? 'the delegation completed after the abort signal; whether it stopped cannot be shown'
        : `the delegation failed after the abort signal for another reason: ${errorText(after.error)}`,
  };
}

function defaultWorkspace(): LiveScenarioWorkspace {
  const record = createScratchWorkspace({});
  return {
    path: record.path,
    release: () => {
      try {
        deleteRegisteredWorkspace(record.id);
      } catch (error) {
        logger.warn(
          `[backend-live-scenarios] scratch cleanup failed — ${errorText(error)} | next: workspace reclaim sweeps it | evidence: ${record.path}`
        );
      }
    },
  };
}

function defaultReadFile(file: string): string | undefined {
  if (!safeExistsSync(file)) return undefined;
  return String(safeReadFile(file, { encoding: 'utf8' }));
}

async function scenarioArtifact(ctx: ScenarioContext): Promise<Attempt> {
  let workspace: LiveScenarioWorkspace;
  try {
    workspace = (ctx.options.createWorkspace ?? defaultWorkspace)();
  } catch (error) {
    return { outcome: 'unreported', detail: `no scratch workspace: ${errorText(error)}` };
  }
  const fileName = `artifact-${ctx.words.m1}.txt`;
  const expected = `HELLO-${ctx.words.m1}`;
  const target = path.join(workspace.path, fileName);
  const controller = new AbortController();
  try {
    let answer: string;
    try {
      answer = await withTimeout(
        ctx.backend.delegateTask(
          `Create a file at the absolute path ${target} containing exactly the text ${expected} and nothing else, then reply DONE.`,
          `Scratch workspace: ${workspace.path}`,
          {
            permission_mode: 'edit',
            signal: controller.signal,
            ...(ctx.options.model ? { model: ctx.options.model } : {}),
          }
        ),
        ctx.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
        'artifact delegation'
      );
    } catch (error) {
      return {
        outcome: 'unreported',
        detail: `the artifact delegation errored, not judged: ${errorText(error)}`,
      };
    } finally {
      ctx.sampleServedMode();
    }
    let content: string | undefined;
    try {
      content = (ctx.options.readFile ?? defaultReadFile)(target);
    } catch (error) {
      return { outcome: 'unreported', detail: `could not read ${fileName}: ${errorText(error)}` };
    }
    const answerExcerpt = typeof answer === 'string' ? { answer_excerpt: excerpt(answer) } : {};
    if (content === undefined) {
      return { outcome: 'fail', detail: `${fileName} was not created`, ...answerExcerpt };
    }
    const ok = content.trim() === expected;
    return {
      outcome: ok ? 'pass' : 'fail',
      detail: ok
        ? `${fileName} exists with the expected content`
        : `${fileName} exists but its content is not ${expected}`,
      ...answerExcerpt,
    };
  } finally {
    // Stop a still-running delegation before its workspace disappears.
    controller.abort('backend live scenario: artifact finished');
    workspace.release();
  }
}

const SCENARIOS: Record<LiveScenarioName, (ctx: ScenarioContext) => Promise<Attempt>> = {
  first: scenarioFirst,
  follow_up: scenarioFollowUp,
  reset_continue: scenarioResetContinue,
  abort: scenarioAbort,
  artifact: scenarioArtifact,
};

/**
 * Execution order differs from record order: reset_continue drops the session,
 * so it runs last; everything that needs the session runs before it.
 */
const EXECUTION_ORDER: readonly LiveScenarioName[] = [
  'first',
  'follow_up',
  'artifact',
  'abort',
  'reset_continue',
];

async function runAttempt(name: LiveScenarioName, ctx: ScenarioContext): Promise<Attempt> {
  ctx.servedModes.clear();
  const attempt = await SCENARIOS[name](ctx).catch((error): Attempt => ({
    outcome: 'unreported',
    detail: `scenario errored, not judged: ${errorText(error)}`,
  }));
  const sampled = [...ctx.servedModes];
  const foreign = sampled.filter((mode) => mode !== ctx.options.mode);
  if (foreign.length > 0 && (attempt.outcome === 'pass' || attempt.outcome === 'fail')) {
    // A turn served by another mode (failover) measures that mode, not this one.
    return {
      ...attempt,
      outcome: 'unreported',
      detail: `served by ${foreign.join(', ')} instead of ${ctx.options.mode}; ${attempt.detail}`,
      served_modes: sampled,
      ...(attempt.continuity ? { continuity: 'unreported' as const } : {}),
    };
  }
  return sampled.length > 0 ? { ...attempt, served_modes: sampled } : attempt;
}

/** A judged failure or an undetermined outcome earns one more attempt. */
function retryable(name: LiveScenarioName, outcome: LiveScenarioOutcome): boolean {
  // An abort `fail` means the provider ignored the signal and is still running;
  // a retry would start a second delegation nothing can stop.
  if (name === 'abort' && outcome === 'fail') return false;
  return outcome === 'fail' || outcome === 'unreported';
}

async function runScenario(
  name: LiveScenarioName,
  ctx: ScenarioContext,
  retries: number
): Promise<LiveScenarioResult> {
  const started = Date.now();
  let attempt = await runAttempt(name, ctx);
  let attempts = 1;
  let firstTry: LiveScenarioOutcome | undefined;
  while (retryable(name, attempt.outcome) && attempts <= retries) {
    firstTry ??= attempt.outcome;
    attempt = await runAttempt(name, ctx);
    attempts += 1;
  }
  return {
    scenario: name,
    ...attempt,
    ...(firstTry ? { first_try: firstTry } : {}),
    attempts,
    duration_ms: Date.now() - started,
  };
}

/** Drive one backend through every scenario and return the record (not persisted). */
export async function runBackendLiveScenarios(
  backend: ReasoningBackend,
  options: RunBackendLiveScenariosOptions
): Promise<BackendLiveScenarioRecord> {
  const now = options.now ?? nowIso;
  const startedAt = now();
  const nonce = options.nonce ?? randomBytes(4).toString('hex');
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const retries = Math.max(0, options.retries ?? 1);
  let lastServedMode: string | undefined;
  const servedModes = new Set<string>();
  const ctx: ScenarioContext = {
    backend,
    options,
    words: { m1: `M1-${nonce}`, m2: `M2-${nonce}`, m3: `M3-${nonce}` },
    nonce,
    servedModes,
    sampleServedMode: () => {
      let sampled: string | undefined;
      try {
        sampled = options.servedMode?.()?.trim() || undefined;
      } catch {
        // Evidence accessors are best effort; absence is simply no sample.
      }
      if (sampled) {
        servedModes.add(sampled);
        lastServedMode = sampled;
      }
    },
    turn: async (prompt) => {
      const controller = new AbortController();
      try {
        return await withTimeout(
          backend.prompt(prompt, {
            context_mode: 'continue',
            signal: controller.signal,
            ...(options.model ? { model: options.model } : {}),
          }),
          turnTimeoutMs,
          'turn'
        );
      } finally {
        // A timed-out turn must not keep running behind the next one.
        controller.abort('backend live scenario: turn settled');
      }
    },
  };

  const results = new Map<LiveScenarioName, LiveScenarioResult>();
  for (const name of EXECUTION_ORDER) {
    const first = results.get('first');
    if (name !== 'first' && first && first.outcome !== 'pass') {
      results.set(name, {
        scenario: name,
        outcome: 'not_run',
        attempts: 0,
        detail: `the first scenario did not pass (${first.outcome}), so this one measured nothing`,
        duration_ms: 0,
      });
      continue;
    }
    const followUp = results.get('follow_up');
    if (name === 'reset_continue' && followUp && followUp.outcome !== 'pass') {
      // "Continuity lost after reset" means nothing unless continuity held before it.
      results.set(name, {
        scenario: name,
        outcome: 'not_run',
        attempts: 0,
        detail: `follow_up did not pass (${followUp.outcome}), so a reset has no continuity to drop`,
        duration_ms: 0,
      });
      continue;
    }
    results.set(name, await runScenario(name, ctx, retries));
  }

  let servedModel: string | undefined;
  try {
    servedModel = options.servedModel?.()?.trim() || undefined;
  } catch {
    // Evidence accessors are best effort; their absence is 'unreported'.
  }
  const servedMode = lastServedMode;

  return {
    version: '1.0.0',
    run_id: options.runId ?? `${startedAt.replace(/[^0-9A-Za-z]/gu, '')}-${options.mode}-${nonce}`,
    mode: options.mode,
    backend_name: backend.name,
    ...(options.model ? { model_requested: options.model } : {}),
    served_model: servedModel ?? 'unreported',
    ...(servedMode ? { served_mode: servedMode } : {}),
    started_at: startedAt,
    finished_at: now(),
    scenarios: LIVE_SCENARIO_NAMES.map((name) => results.get(name)!),
  };
}

/* ------------------------------------------------------------------ store */

/** One JSON file per run, so the retention janitor's mtime TTL can age runs out. */
export function backendLiveScenarioDir(): string {
  return assertSafeRepositoryPath(pathResolver.shared('runtime/backend-live-scenarios'), {
    allowMissingLeaf: true,
  });
}

function safeRunFileName(runId: string): string {
  return `${runId.replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 160)}.json`;
}

export function recordBackendLiveScenarioRun(
  record: BackendLiveScenarioRecord,
  options: { dir?: string } = {}
): string {
  const dir = options.dir ?? backendLiveScenarioDir();
  safeMkdir(dir, { recursive: true });
  const filePath = path.join(dir, safeRunFileName(record.run_id));
  writeJson(filePath, record);
  return filePath;
}

function isLiveScenarioRecord(value: unknown): value is BackendLiveScenarioRecord {
  const record = value as Partial<BackendLiveScenarioRecord> | null;
  return (
    Boolean(record) &&
    typeof record?.mode === 'string' &&
    typeof record?.run_id === 'string' &&
    Array.isArray(record?.scenarios)
  );
}

/** Every recorded run; unreadable or malformed files are skipped, not fatal. */
export function loadBackendLiveScenarioRecords(
  options: { dir?: string } = {}
): BackendLiveScenarioRecord[] {
  const dir = options.dir ?? backendLiveScenarioDir();
  if (!safeExistsSync(dir)) return [];
  const records: BackendLiveScenarioRecord[] = [];
  for (const entry of safeReaddir(dir).sort()) {
    if (!entry.endsWith('.json')) continue;
    try {
      const parsed = readJsonIfPresent<unknown>(path.join(dir, entry));
      if (isLiveScenarioRecord(parsed)) records.push(parsed);
    } catch {
      // A torn or foreign file is not evidence; skip it.
    }
  }
  return records;
}

/* --------------------------------------------------------------- render */

export function formatBackendLiveScenarioTable(
  records: readonly BackendLiveScenarioRecord[]
): string {
  const header = ['mode', 'model', 'served_model', ...LIVE_SCENARIO_NAMES];
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const record of records) {
    const cells = LIVE_SCENARIO_NAMES.map((name) => {
      const result = record.scenarios.find((scenario) => scenario.scenario === name);
      if (!result) return 'unreported';
      return result.first_try
        ? `${result.outcome} (first try: ${result.first_try})`
        : result.outcome;
    });
    lines.push(
      `| ${[
        record.mode,
        record.model_requested ?? 'default',
        record.served_mode && record.served_mode !== record.mode
          ? `${record.served_model} (served by ${record.served_mode})`
          : record.served_model,
        ...cells,
      ].join(' | ')} |`
    );
  }
  return lines.join('\n');
}
