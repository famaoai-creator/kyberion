/**
 * Cursor SDK Query Helper — thin wrapper around `@cursor/sdk` for one-shot,
 * tool-less text completions (the Cursor counterpart of `claude-agent-query`).
 *
 * Enforces:
 *   - `tools: []` — the model can only answer with text (no file / shell effects)
 *   - an empty scratch `cwd` inside the runtime floor, deleted after the call
 *   - `settingSources: []` — no `.cursor/` rules, hooks or MCP servers are loaded
 *   - a scratch JSONL store, so prompts are not checkpointed in the SDK's
 *     default on-disk state
 *   - operator-only credentials: a tenant / personal-bound execution is refused
 *
 * Cursor's SDK has no native `json_schema` output format, so structured ops
 * validate the returned text through `runStructuredReasoningOp` (Zod) in the
 * backend — this module only returns raw text.
 *
 * Calls are stateless by default (one agent + scratch dirs per call). A caller
 * that passes `contextMode` ('fresh' | 'continue') together with a
 * {@link CursorSdkSession} opts in to a continued conversation on one agent:
 * turns are serialized FIFO, the agent is closed after an idle TTL, and any
 * failure, model change or reset discards it (see {@link CursorSdkSession}).
 *
 * "Local" in the Cursor SDK means the agent loop runs in this process; all
 * inference still goes to Cursor's hosted models (`data_egress: external-api`).
 */

import { assertOperatorNativeCredentialOwner } from '../agent/native-credential-fence.js';
import { credentialExecutionIdentity } from '../foundation/credential-binding.js';
import { logger } from '../core.js';
import { assertReasoningEgressAllowed } from '../reasoning/reasoning-egress-scope.js';
import { resolveReasoningProviderSecretEnvValue } from '../reasoning/reasoning-provider-registry.js';
import {
  createScratchWorkspace,
  deleteRegisteredWorkspace,
} from '../workforce/workspace-ledger.js';
import { markDelegationExecutionStarted } from '../workforce/delegation-execution-tracker.js';
import { recordCliUsage, type CliUsageReport } from './cli-usage-metering.js';

export const CURSOR_SDK_API_KEY_ENV = 'CURSOR_API_KEY';
export const CURSOR_SDK_MODEL_ENV = 'KYBERION_CURSOR_SDK_MODEL';
export const CURSOR_SDK_TIMEOUT_ENV = 'KYBERION_CURSOR_SDK_TIMEOUT_MS';
export const CURSOR_SDK_DEFAULT_MODEL = 'composer-2.5';
export const CURSOR_SDK_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const CURSOR_SDK_DEFAULT_SESSION_IDLE_TTL_MS = 15 * 60 * 1000;

/** The subset of `@cursor/sdk` token usage this adapter reads. */
export interface CursorSdkTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CursorSdkRunResult {
  status: 'finished' | 'error' | 'cancelled';
  result?: string;
  error?: { message: string; code?: string };
  usage?: CursorSdkTokenUsage;
}

export interface CursorSdkRun {
  wait(): Promise<CursorSdkRunResult>;
  cancel(): Promise<void>;
}

export interface CursorSdkAgent {
  send(message: string): Promise<CursorSdkRun>;
  close(): void;
}

export interface CursorSdkCreateAgentOptions {
  apiKey: string;
  model: string;
  /** Replaces Cursor's built-in system prompt (local agents; account-gated). */
  systemPrompt?: string;
  /** Empty scratch directory used as the agent workspace. */
  cwd: string;
  /** Scratch directory for the agent's conversation store. */
  storeDir: string;
}

/** Seam over `@cursor/sdk`; tests inject a fake runtime. */
export interface CursorSdkRuntime {
  createAgent(options: CursorSdkCreateAgentOptions): Promise<CursorSdkAgent>;
}

type CursorSdkModule = typeof import('@cursor/sdk');

/**
 * Loads `@cursor/sdk` lazily so importing Kyberion core does not pay for it.
 *
 * `webpackIgnore` keeps the import out of surface bundles: the SDK lazy-loads
 * its own files through a computed `import()`, which makes webpack pull every
 * file under `dist/esm` (including `.d.ts.map`) into the bundle and fail to
 * parse them. Node resolves it at runtime from the workspace `node_modules`.
 */
export async function loadCursorSdkRuntime(): Promise<CursorSdkRuntime> {
  const sdk = (await import(/* webpackIgnore: true */ '@cursor/sdk')) as CursorSdkModule;
  return {
    async createAgent(options) {
      const store = new sdk.JsonlLocalAgentStore(options.storeDir);
      const agent = await sdk.Agent.create({
        apiKey: options.apiKey,
        model: { id: options.model },
        ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        tools: [],
        local: { cwd: options.cwd, store, settingSources: [] },
      });
      return {
        send: (message) => agent.send(message),
        close: () => agent.close(),
      };
    },
  };
}

export interface CursorSdkQueryParams {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Send the system prompt through the SDK's native `systemPrompt` option.
   * Default `false` (folded into the user message): accounts without the
   * feature reject the run only after ~20s of SDK-internal retries, so the
   * native path is opt-in for accounts known to have it enabled. Stateless
   * calls only — a continued conversation always folds the system prompt
   * into its messages (first message, and again whenever it changes).
   */
  nativeSystemPrompt?: boolean;
  /**
   * Opt in to a continued conversation (requires `session` — passing one
   * without the other throws). `undefined` keeps the call stateless and never
   * touches the session. `'fresh'` discards the session's conversation and
   * starts a new one with this call; `'continue'` appends to it (starting one
   * when none is held).
   */
  contextMode?: 'fresh' | 'continue';
  session?: CursorSdkSession;
}

export interface CursorSdkQueryDeps {
  runtime?: CursorSdkRuntime;
  /** Operator key override (tests); otherwise resolved through the secret registry. */
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
}

/** Operator credential for the SDK: environment first, then the introduced secret. */
export function resolveCursorSdkApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveReasoningProviderSecretEnvValue(CURSOR_SDK_API_KEY_ENV, env);
}

export class CursorSdkQueryError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'CursorSdkQueryError';
  }
}

function toUsageReport(
  model: string,
  usage: CursorSdkTokenUsage | undefined
): CliUsageReport | undefined {
  if (!usage) return undefined;
  return {
    entries: [
      {
        model,
        usage: {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          ...(usage.cacheReadTokens ? { cache_read_tokens: usage.cacheReadTokens } : {}),
          ...(usage.cacheWriteTokens ? { cache_write_tokens: usage.cacheWriteTokens } : {}),
        },
      },
    ],
  };
}

/**
 * Per-process memory of whether this account accepts a custom `systemPrompt`.
 * Cursor rejects it at run time (`invalid_argument`), not at `Agent.create`, so
 * the first call learns it and later calls skip the rejected path.
 */
let systemPromptAccepted: boolean | undefined;

/** Test seam: forget the learned account capability. */
export function resetCursorSdkCapabilityCache(): void {
  systemPromptAccepted = undefined;
}

function isSystemPromptRejected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /system[-_ ]?prompt/iu.test(message) && /not enabled|access/iu.test(message);
}

interface CursorSdkSessionState {
  agent: CursorSdkAgent;
  workspace: ScratchHandle;
  storeWorkspace: ScratchHandle;
  model: string;
  /** System prompt already present in the conversation, if any. */
  systemPrompt?: string;
}

type ScratchHandle = ReturnType<typeof createScratchWorkspace>;

function disposeScratch(handles: readonly ScratchHandle[]): void {
  for (const scratch of handles) {
    try {
      deleteRegisteredWorkspace(scratch.id);
    } catch (error) {
      logger.warn(
        `[cursor-sdk] scratch cleanup failed — ${(error as Error).message} | next: workspace reclaim sweeps it | evidence: ${scratch.path}`
      );
    }
  }
}

/**
 * One continued Cursor conversation owned by a backend instance.
 *
 * - **Serialized**: turns run FIFO (`exclusive`), so concurrent `'continue'`
 *   callers never interleave on the one agent.
 * - **Idle TTL**: the agent and its scratch directories are released
 *   `idleTtlMs` after the last turn ends (the timer is unref'd and only armed
 *   while no turn is queued or running).
 * - **Fail-closed**: a failed, cancelled or timed-out turn, a model change, a
 *   `'fresh'` turn and `reset()` all discard the conversation, because the
 *   provider-side context may already have been mutated.
 */
export class CursorSdkSession {
  private state: CursorSdkSessionState | undefined;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly idleTtlMs: number = CURSOR_SDK_DEFAULT_SESSION_IDLE_TTL_MS) {}

  /** True while a conversation (agent + scratch directories) is held. */
  get active(): boolean {
    return this.state !== undefined;
  }

  async exclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending += 1;
    this.clearIdleTimer();
    try {
      if (signal?.aborted) throw new CursorSdkQueryError('[cursor-sdk] aborted before start');
      if (signal) {
        // A queued turn must not wait out the running turn after its caller
        // aborted — losing this race still releases the tail correctly below.
        let rejectAborted!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
          rejectAborted = () =>
            reject(new CursorSdkQueryError('[cursor-sdk] aborted before start'));
        });
        signal.addEventListener('abort', rejectAborted, { once: true });
        try {
          await Promise.race([previous, aborted]);
        } finally {
          signal.removeEventListener('abort', rejectAborted);
        }
      } else {
        await previous;
      }
      return await fn();
    } finally {
      this.pending -= 1;
      release();
      if (this.pending === 0) this.armIdleTimer();
    }
  }

  /** Must run inside `exclusive`. */
  current(): CursorSdkSessionState | undefined {
    return this.state;
  }

  /** Must run inside `exclusive`. Creates the agent and its scratch directories. */
  async start(
    runtime: CursorSdkRuntime,
    options: { apiKey: string; model: string; timeoutMs: number; signal?: AbortSignal }
  ): Promise<CursorSdkSessionState> {
    const workspace = createScratchWorkspace({});
    const storeWorkspace = createScratchWorkspace({});
    try {
      const agent = await createAgentWithin(
        runtime,
        {
          apiKey: options.apiKey,
          model: options.model,
          cwd: workspace.path,
          storeDir: storeWorkspace.path,
        },
        options.timeoutMs,
        options.signal
      );
      this.state = { agent, workspace, storeWorkspace, model: options.model };
      return this.state;
    } catch (error) {
      disposeScratch([workspace, storeWorkspace]);
      throw error;
    }
  }

  /** Must run inside `exclusive`. Idempotent and never throws. */
  drop(): void {
    const state = this.state;
    this.state = undefined;
    if (!state) return;
    try {
      state.agent.close();
    } catch {
      /* disposal is best-effort */
    }
    disposeScratch([state.workspace, state.storeWorkspace]);
  }

  /** Discard the conversation after any in-flight or queued turn has finished. */
  async reset(): Promise<void> {
    await this.exclusive(async () => this.drop());
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.state || !(this.idleTtlMs > 0)) return;
    const timer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.exclusive(async () => {
        // Another turn queued behind this release: it owns the conversation now.
        if (this.pending > 1) return;
        logger.debug('[cursor-sdk] session idle TTL elapsed; releasing agent');
        this.drop();
      }).catch(() => undefined);
    }, this.idleTtlMs);
    timer.unref?.();
    this.idleTimer = timer;
  }
}

async function waitForRun(
  run: CursorSdkRun,
  params: Pick<CursorSdkQueryParams, 'signal'>,
  timeoutMs: number
): Promise<CursorSdkRunResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    void run.cancel().catch(() => undefined);
  };
  params.signal?.addEventListener('abort', onAbort, { once: true });
  // addEventListener never fires for an already-aborted signal: a caller that
  // aborted between send() and here must still see the run cancelled.
  if (params.signal?.aborted) onAbort();
  try {
    return await Promise.race([
      run.wait().catch(asSdkError('run.wait')),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void run.cancel().catch(() => undefined);
          reject(new CursorSdkQueryError(`[cursor-sdk] timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    params.signal?.removeEventListener('abort', onAbort);
  }
}

/** Milliseconds left on a shared call deadline; never below 1 so a raced
 * stage still gets a real (if already-expired) timer instead of `0`/negative. */
function remainingMs(deadline: number): number {
  return Math.max(deadline - Date.now(), 1);
}

/** SDK-origin rejections get the typed, greppable surface; our own errors pass through. */
function asSdkError(op: string) {
  return (error: unknown): never => {
    if (error instanceof CursorSdkQueryError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined;
    throw new CursorSdkQueryError(`[cursor-sdk] ${op} failed: ${message}`, code);
  };
}

/**
 * Races `pending` against a millisecond budget and an optional abort signal.
 * `sweep` runs exactly once when the race is lost — it cleans up whatever the
 * abandoned promise may still deliver (a late agent is closed, a late run is
 * cancelled). Both surfaces produce a typed, prefixed error.
 */
async function withinDeadline<T>(
  pending: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  sweep: () => void,
  timeoutMessage: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let won = false;
  let lost = false;
  let lose!: (error: CursorSdkQueryError) => void;
  const race = new Promise<never>((_resolve, reject) => {
    lose = (error) => {
      if (won || lost) return;
      lost = true;
      try {
        sweep();
      } finally {
        reject(error);
      }
    };
    timer = setTimeout(() => lose(new CursorSdkQueryError(timeoutMessage)), timeoutMs);
  });
  // Mark `pending` settled so a late lose() can't sweep a resource the caller
  // already owns (a closed agent / cancelled run would be handed back).
  const tracked = pending.then(
    (value) => {
      won = true;
      return value;
    },
    (error: unknown) => {
      won = true;
      throw error;
    }
  );
  const onAbort = (): void => lose(new CursorSdkQueryError('[cursor-sdk] aborted'));
  signal?.addEventListener('abort', onAbort, { once: true });
  // addEventListener never fires for an already-aborted signal.
  if (signal?.aborted) onAbort();
  try {
    return await Promise.race([tracked, race]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * `Agent.create` is a network handshake — without a bound it can stall the
 * call (and, inside a session, the whole FIFO) forever. When the budget or an
 * abort wins the race, the pending create is swept: a late-resolving agent is
 * closed so no SDK agent leaks.
 */
async function createAgentWithin(
  runtime: CursorSdkRuntime,
  options: CursorSdkCreateAgentOptions,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<CursorSdkAgent> {
  const create = runtime.createAgent(options);
  return withinDeadline(
    create.catch(asSdkError('Agent.create')),
    timeoutMs,
    signal,
    () => {
      void create
        .then(
          (agent) => agent.close(),
          () => undefined
        )
        .catch(() => undefined);
    },
    `[cursor-sdk] Agent.create timed out after ${timeoutMs}ms`
  );
}

/**
 * `agent.send` crosses into the SDK runtime and can stay pending the same way
 * `Agent.create` can — it is covered by the shared call deadline and abort.
 * When the race is lost, the late-arriving run is cancelled so nothing keeps
 * running provider-side.
 */
async function sendWithin(
  agent: CursorSdkAgent,
  message: string,
  params: Pick<CursorSdkQueryParams, 'signal'>,
  timeoutMs: number
): Promise<CursorSdkRun> {
  const send = agent.send(message);
  return withinDeadline(
    send.catch(asSdkError('send')),
    timeoutMs,
    params.signal,
    () => {
      void send
        .then(
          (run) => run.cancel(),
          () => undefined
        )
        .catch(() => undefined);
    },
    `[cursor-sdk] send timed out after ${timeoutMs}ms`
  );
}

/** SDK phrasings for an unusable model id — kept loose on purpose so the
 * `next:` hint survives error-text wording changes. */
const MODEL_UNAVAILABLE_PATTERN =
  /cannot use this model|invalid[_ -]?model|unknown model|model\b[^.]*\bnot (?:found|available|supported)/iu;

/** Final assistant text of a settled run, or the typed failure. */
function unwrapRunResult(result: CursorSdkRunResult): string {
  if (result.status === 'cancelled') {
    throw new CursorSdkQueryError('[cursor-sdk] run was cancelled');
  }
  if (result.status === 'error') {
    const detail = result.error?.message ?? 'unknown error';
    const next = MODEL_UNAVAILABLE_PATTERN.test(detail)
      ? ` | next: set ${CURSOR_SDK_MODEL_ENV} to a valid model id — list options with Cursor.models.list()`
      : '';
    throw new CursorSdkQueryError(`[cursor-sdk] run failed: ${detail}${next}`, result.error?.code);
  }
  const text = result.result ?? '';
  if (!text.trim()) throw new CursorSdkQueryError('[cursor-sdk] run finished without text');
  return text;
}

/**
 * Run one tool-less completion through the Cursor SDK and return the final
 * assistant text.
 */
export async function runCursorSdkText(
  params: CursorSdkQueryParams,
  deps: CursorSdkQueryDeps = {}
): Promise<string> {
  assertOperatorNativeCredentialOwner(credentialExecutionIdentity());
  assertReasoningEgressAllowed('cursor-sdk');
  if (params.signal?.aborted) throw new CursorSdkQueryError('[cursor-sdk] aborted before start');
  // Half-bound context is a contract violation: 'continue' without a session
  // would silently degrade to a stateless call. Checked before any I/O.
  if (Boolean(params.contextMode) !== Boolean(params.session)) {
    throw new CursorSdkQueryError('[cursor-sdk] contextMode and session must be passed together');
  }

  const apiKey = deps.apiKey?.trim() || resolveCursorSdkApiKey(deps.env);
  if (!apiKey) {
    throw new CursorSdkQueryError(
      `[cursor-sdk] ${CURSOR_SDK_API_KEY_ENV} is not configured — no Cursor API key is available | next: pnpm kyberion secret introduce cursor API_KEY | evidence: cursor-sdk`
    );
  }
  const model = params.model?.trim() || CURSOR_SDK_DEFAULT_MODEL;
  const timeoutMs = params.timeoutMs ?? CURSOR_SDK_DEFAULT_TIMEOUT_MS;
  const runtime = deps.runtime ?? (await loadCursorSdkRuntime());

  if (params.contextMode && params.session) {
    const session = params.session;
    return session.exclusive(
      () => runSessionTurn(params, session, { apiKey, model, timeoutMs, runtime }),
      params.signal
    );
  }
  return runOneShot(params, { apiKey, model, timeoutMs, runtime });
}

interface TurnContext {
  apiKey: string;
  model: string;
  timeoutMs: number;
  runtime: CursorSdkRuntime;
}

async function runSessionTurn(
  params: CursorSdkQueryParams,
  session: CursorSdkSession,
  ctx: TurnContext
): Promise<string> {
  const started = Date.now();
  const deadline = started + ctx.timeoutMs;
  let requestSent = false;
  let status: 'success' | 'error' = 'error';
  let usage: CursorSdkTokenUsage | undefined;
  let completionChars = 0;
  const promptChars = params.systemPrompt.length + params.userPrompt.length;
  try {
    if (params.contextMode === 'fresh') session.drop();
    let state = session.current();
    if (state && state.model !== ctx.model) {
      logger.debug(
        `[cursor-sdk] model changed (${state.model} → ${ctx.model}); starting a new conversation`
      );
      session.drop();
      state = undefined;
    }
    state ??= await session.start(ctx.runtime, {
      apiKey: ctx.apiKey,
      model: ctx.model,
      timeoutMs: remainingMs(deadline),
      signal: params.signal,
    });

    // The system prompt rides in the conversation once; resend only if it changed.
    const message =
      state.systemPrompt === params.systemPrompt
        ? params.userPrompt.trim()
        : `${params.systemPrompt.trim()}\n\n${params.userPrompt.trim()}`;
    // R5: the prompt leaves the process at send(); every check above is pre-start.
    markDelegationExecutionStarted();
    requestSent = true;
    const run = await sendWithin(state.agent, message, params, remainingMs(deadline));
    const settled = await waitForRun(run, params, remainingMs(deadline));
    usage = settled.usage;
    const text = unwrapRunResult(settled);
    state.systemPrompt = params.systemPrompt;
    completionChars = text.length;
    status = 'success';
    return text;
  } catch (error) {
    // Fail closed: the provider-side context may already have been mutated.
    session.drop();
    throw error;
  } finally {
    recordCliUsage('cursor-sdk', ctx.model, started, status, {
      report: toUsageReport(ctx.model, usage),
      promptChars,
      completionChars,
      requestNotSent: !requestSent,
      agent: 'cursor-sdk',
    });
  }
}

async function runOneShot(params: CursorSdkQueryParams, ctx: TurnContext): Promise<string> {
  const { apiKey, model, timeoutMs, runtime } = ctx;
  const workspace = createScratchWorkspace({});
  const storeWorkspace = createScratchWorkspace({});
  const started = Date.now();
  // One deadline covers createAgent → send → wait across both attempts, so the
  // native→folded retry can never double the per-call budget.
  const deadline = started + timeoutMs;
  let requestSent = false;
  let status: 'success' | 'error' = 'error';
  let usage: CursorSdkTokenUsage | undefined;
  let completionChars = 0;
  const promptChars = params.systemPrompt.length + params.userPrompt.length;
  let agent: CursorSdkAgent | undefined;
  try {
    const attempt = async (nativeSystemPrompt: boolean): Promise<CursorSdkRunResult> => {
      agent = await createAgentWithin(
        runtime,
        {
          apiKey,
          model,
          ...(nativeSystemPrompt ? { systemPrompt: params.systemPrompt } : {}),
          cwd: workspace.path,
          storeDir: storeWorkspace.path,
        },
        remainingMs(deadline),
        params.signal
      );
      const message = nativeSystemPrompt
        ? params.userPrompt
        : `${params.systemPrompt.trim()}\n\n${params.userPrompt.trim()}`;
      // R5: the prompt leaves the process at send(); every check above is pre-start.
      markDelegationExecutionStarted();
      requestSent = true;
      const run = await sendWithin(agent, message, params, remainingMs(deadline));
      const settled = await waitForRun(run, params, remainingMs(deadline));
      if (
        nativeSystemPrompt &&
        settled.status === 'error' &&
        isSystemPromptRejected(settled.error?.message)
      ) {
        // Thrown (not returned) so the caller folds the prompt and retries once.
        throw new CursorSdkQueryError(settled.error!.message, settled.error?.code);
      }
      return settled;
    };

    let result: CursorSdkRunResult;
    const useNativeSystemPrompt =
      params.nativeSystemPrompt === true && systemPromptAccepted !== false;
    try {
      result = await attempt(useNativeSystemPrompt);
      if (useNativeSystemPrompt) systemPromptAccepted = true;
    } catch (error) {
      // `systemPrompt` is enabled per Cursor account; fold it into the prompt instead.
      if (!useNativeSystemPrompt || !isSystemPromptRejected(error)) throw error;
      systemPromptAccepted = false;
      logger.debug('[cursor-sdk] systemPrompt not enabled for this account; folding into prompt');
      // Clear-then-close so a throwing close() neither masks the retry nor
      // double-closes in finally.
      const stale = agent;
      agent = undefined;
      try {
        stale?.close();
      } catch {
        /* disposal is best-effort */
      }
      result = await attempt(false);
    }
    usage = result.usage;
    const text = unwrapRunResult(result);
    completionChars = text.length;
    status = 'success';
    return text;
  } finally {
    try {
      agent?.close();
    } catch {
      /* disposal is best-effort */
    }
    disposeScratch([workspace, storeWorkspace]);
    recordCliUsage('cursor-sdk', model, started, status, {
      report: toUsageReport(model, usage),
      promptChars,
      completionChars,
      requestNotSent: !requestSent,
      agent: 'cursor-sdk',
    });
  }
}
