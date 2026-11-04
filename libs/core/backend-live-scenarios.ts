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
 * - A follow-up answer that still carries the first turn's word is a replayed
 *   transcript (stale/echo), not a fresh answer, and fails.
 * - `unreported` means the outcome could not be determined (empty answer,
 *   unreadable workspace, a delegation that settled before it could be
 *   cancelled). It is never counted as a pass.
 * - When `first` does not pass, nothing after it measured anything, so the
 *   remaining scenarios are `not_run` rather than failures.
 * - A failing scenario is retried once; the first attempt's outcome is kept in
 *   `first_try`, so a flaky pass stays visible.
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
  /** reset_continue only: what the backend remembered after resetSession(). */
  continuity_after_reset?: 'lost' | 'retained' | 'unreported';
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
  /** Mode the reasoning chain says served the calls (a failover is a substitution). */
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
  /** How long a cancelled delegation may take to reach a terminal state. */
  abortTimeoutMs?: number;
  /** Delay between starting the long delegation and cancelling it. */
  abortStartDelayMs?: number;
  /** Retries for a failing scenario (default 1). */
  retries?: number;
  /** Evidence of the served model, when the caller has any. */
  servedModel?: () => string | undefined;
  /** Evidence of the served mode (e.g. the reasoning chain's last-served marker). */
  servedMode?: () => string | undefined;
  /** Test seam: scratch workspace for the artifact scenario. */
  createWorkspace?: () => LiveScenarioWorkspace;
  /** Test seam: file reads for the artifact check. */
  readFile?: (file: string) => string | undefined;
}

const DEFAULT_TURN_TIMEOUT_MS = 180_000;
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
  turn: (prompt: string) => Promise<string>;
}

/** Ask one turn; a non-string or blank answer is something we cannot judge. */
async function askForWord(
  ctx: ScenarioContext,
  prompt: string
): Promise<{ answer: string } | Attempt> {
  try {
    const answer = await ctx.turn(prompt);
    if (typeof answer !== 'string' || answer.trim() === '') {
      return { outcome: 'unreported', detail: 'the backend returned an empty answer' };
    }
    return { answer };
  } catch (error) {
    return { outcome: 'fail', detail: `the turn failed: ${errorText(error)}` };
  }
}

async function scenarioFirst(ctx: ScenarioContext): Promise<Attempt> {
  const reply = await askForWord(ctx, `Reply with exactly: ${ctx.words.m1}`);
  if (!('answer' in reply)) return reply;
  const ok = reply.answer.includes(ctx.words.m1);
  return {
    outcome: ok ? 'pass' : 'fail',
    detail: ok ? `answered ${ctx.words.m1}` : `answered without ${ctx.words.m1}`,
    answer_excerpt: excerpt(reply.answer),
  };
}

async function scenarioFollowUp(ctx: ScenarioContext): Promise<Attempt> {
  const { m1, m2 } = ctx.words;
  const reply = await askForWord(ctx, `Reply with exactly: ${m2}`);
  if (!('answer' in reply)) return reply;
  if (reply.answer.includes(m1)) {
    return {
      outcome: 'fail',
      detail: `the follow-up repeats the first turn's answer (${m1}): stale or replayed transcript`,
      answer_excerpt: excerpt(reply.answer),
    };
  }
  if (!reply.answer.includes(m2)) {
    return {
      outcome: 'fail',
      detail: `the follow-up answered without ${m2}`,
      answer_excerpt: excerpt(reply.answer),
    };
  }
  const recall = await askForWord(
    ctx,
    'What exact word did I ask you to reply with in my very first message of this conversation? Reply with just that word.'
  );
  if (!('answer' in recall)) return recall;
  const ok = recall.answer.includes(m1);
  return {
    outcome: ok ? 'pass' : 'fail',
    detail: ok
      ? `answered ${m2} fresh, then recalled ${m1}: session continuity held`
      : `answered ${m2} but did not recall ${m1}: no session continuity`,
    answer_excerpt: excerpt(recall.answer),
  };
}

async function scenarioResetContinue(ctx: ScenarioContext): Promise<Attempt> {
  if (typeof ctx.backend.resetSession !== 'function') {
    return { outcome: 'not_run', detail: 'the backend exposes no resetSession()' };
  }
  try {
    await ctx.backend.resetSession();
  } catch (error) {
    return { outcome: 'fail', detail: `resetSession() threw: ${errorText(error)}` };
  }
  const { m1, m3 } = ctx.words;
  const fresh = await askForWord(ctx, `Reply with exactly: ${m3}`);
  if (!('answer' in fresh)) return { ...fresh, continuity_after_reset: 'unreported' };
  if (!fresh.answer.includes(m3)) {
    return {
      outcome: 'fail',
      detail: `after resetSession() the backend answered without ${m3}: it cannot continue`,
      answer_excerpt: excerpt(fresh.answer),
      continuity_after_reset: 'unreported',
    };
  }
  const recall = await askForWord(
    ctx,
    'What exact word did I ask you to reply with in my very first message of this conversation? Reply with just that word.'
  );
  if (!('answer' in recall)) return { ...recall, continuity_after_reset: 'unreported' };
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

async function scenarioAbort(ctx: ScenarioContext): Promise<Attempt> {
  if (typeof ctx.backend.delegateTaskHandle !== 'function') {
    return { outcome: 'not_run', detail: 'the backend exposes no delegateTaskHandle()' };
  }
  const abortTimeoutMs = ctx.options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
  let handle;
  try {
    handle = ctx.backend.delegateTaskHandle(
      'Count slowly from 1 to 10000, one number per line, explaining each number in a full paragraph. Do not stop early.',
      undefined,
      { ...(ctx.options.model ? { model: ctx.options.model } : {}) }
    );
  } catch (error) {
    return { outcome: 'fail', detail: `delegateTaskHandle() threw: ${errorText(error)}` };
  }
  // Settle the join promise up front so a late provider rejection is observed.
  const joined = handle.join().then(
    () => 'resolved' as const,
    () => 'rejected' as const
  );
  await delay(ctx.options.abortStartDelayMs ?? DEFAULT_ABORT_START_DELAY_MS);
  if (handle.status().status !== 'started') {
    return {
      outcome: 'unreported',
      detail: `the delegation settled (${handle.status().status}) before it could be cancelled, so abort was not exercised`,
    };
  }
  try {
    await withTimeout(handle.cancel('backend live scenario: abort'), abortTimeoutMs, 'cancel()');
  } catch (error) {
    return { outcome: 'fail', detail: `cancel() did not settle: ${errorText(error)}` };
  }
  const status = handle.status().status;
  let joinOutcome: 'resolved' | 'rejected' | 'pending';
  try {
    joinOutcome = await withTimeout(joined, abortTimeoutMs, 'join()');
  } catch {
    joinOutcome = 'pending';
  }
  const ok = status === 'cancelled' && joinOutcome === 'rejected';
  return {
    outcome: ok ? 'pass' : 'fail',
    detail: ok
      ? `cancel() reached the cancelled terminal state and join() refused the result`
      : `after cancel() status=${status}, join() ${joinOutcome}`,
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
  try {
    let answer: string;
    try {
      answer = await withTimeout(
        ctx.backend.delegateTask(
          `Create a file at the absolute path ${target} containing exactly the text ${expected} and nothing else, then reply DONE.`,
          `Scratch workspace: ${workspace.path}`,
          {
            permission_mode: 'edit',
            ...(ctx.options.model ? { model: ctx.options.model } : {}),
          }
        ),
        ctx.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
        'artifact delegation'
      );
    } catch (error) {
      return { outcome: 'fail', detail: `the artifact delegation failed: ${errorText(error)}` };
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

async function runScenario(
  name: LiveScenarioName,
  ctx: ScenarioContext,
  retries: number
): Promise<LiveScenarioResult> {
  const started = Date.now();
  let attempt = await SCENARIOS[name](ctx).catch((error): Attempt => ({
    outcome: 'fail',
    detail: `scenario threw: ${errorText(error)}`,
  }));
  let attempts = 1;
  let firstTry: LiveScenarioOutcome | undefined;
  while (attempt.outcome === 'fail' && attempts <= retries) {
    firstTry ??= attempt.outcome;
    attempt = await SCENARIOS[name](ctx).catch((error): Attempt => ({
      outcome: 'fail',
      detail: `scenario threw: ${errorText(error)}`,
    }));
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
  const ctx: ScenarioContext = {
    backend,
    options,
    words: { m1: `M1-${nonce}`, m2: `M2-${nonce}`, m3: `M3-${nonce}` },
    turn: (prompt) =>
      withTimeout(
        backend.prompt(prompt, {
          context_mode: 'continue',
          ...(options.model ? { model: options.model } : {}),
        }),
        turnTimeoutMs,
        'turn'
      ),
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
    results.set(name, await runScenario(name, ctx, retries));
  }

  let servedModel: string | undefined;
  let servedMode: string | undefined;
  try {
    servedModel = options.servedModel?.()?.trim() || undefined;
    servedMode = options.servedMode?.()?.trim() || undefined;
  } catch {
    // Evidence accessors are best effort; their absence is 'unreported'.
  }

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
