/**
 * Delegation Concurrency & Wall-Clock Budget — XP-06 (process-face resource
 * governance)
 *
 * Each CLI provider spawned via `AgentDispatcher.dispatch` consumes local
 * CPU/memory/tokens with no ceiling: nothing stops a burst of delegations
 * from saturating the machine, and nothing bounds how long a single child
 * may run. This module adds two independent controls around the same async
 * unit of work:
 *
 * 1. {@link withDelegationSlot} — a process-wide FIFO semaphore: a global
 *    concurrency cap plus a per-provider cap, built on the existing
 *    {@link Semaphore} primitive (`semaphore.ts`, already used for
 *    `llmSemaphore`) rather than a second queue implementation. Saturated
 *    callers queue; none are ever rejected for saturation.
 * 2. {@link withWallClockBudget} — a wall-clock ceiling on the same unit of
 *    work. On expiry it abandons the wait, records the timeout (both in an
 *    in-memory list callers/tests can inspect, and — best-effort — into the
 *    kill-switch governance ledger via `recordGovernanceAction`), and, when
 *    the caller supplies a killable {@link DelegationChildHandle}, escalates
 *    SIGTERM → SIGKILL against it.
 *
 * Config (env, matching the existing `KYBERION_LLM_CONCURRENCY` /
 * `KYBERION_*` single-var convention rather than the capability registry
 * file): the registry (`provider-capability-registry.ts`, XP-01) is a
 * TTL-cached *probe snapshot* refreshed on its own cadence; splicing static
 * ops config (concurrency caps) into that would couple two independent
 * lifecycles for no benefit. Caps live in env instead:
 *  - `KYBERION_DELEGATION_MAX_CONCURRENCY` — global cap (default 4).
 *  - `KYBERION_DELEGATION_PROVIDER_MAX_CONCURRENCY` — uniform per-provider
 *    cap applied to every provider that has no explicit override (default 2).
 *  - `KYBERION_DELEGATION_PROVIDER_CAPS` — optional JSON object
 *    (`{"claude":3,"codex":1}`) overriding the uniform cap for specific
 *    provider ids.
 *  - `KYBERION_DELEGATION_WALL_CLOCK_MS` — wall-clock budget per delegation
 *    (default 10 minutes).
 *  - `KYBERION_DELEGATION_KILL_GRACE_MS` — SIGTERM → SIGKILL grace window
 *    (default 5s).
 *
 * PROCESS-FACE WIRING: all three CLI backends (`shell-claude-cli-backend.ts`,
 * `codex-cli-query.ts`, `agy-cli-backend.ts`) spawn their delegation's child
 * process asynchronously (`node:child_process` `spawn`, not `spawnSync`), so
 * each one's `spawnCli` wraps its awaited child-process promise in
 * {@link withWallClockBudget} directly, passing a real
 * {@link DelegationChildHandle} built via
 * {@link delegationChildHandleFromChildProcess}. On expiry the SIGTERM ->
 * SIGKILL escalation therefore now kills the actual OS process, not just an
 * abandoned `Promise`. This is layered *underneath* `agent-dispatch.ts`'s own
 * `dispatchWithConcurrencyGovernance` (which still wraps the whole
 * `delegateTask()` call with its own, handle-less budget for call sites that
 * bypass the dispatcher plane entirely, e.g. `runStructured`/document/browser
 * agent tasks) — nesting two independent wall-clock races over the same unit
 * of work is redundant but not incorrect; only the inner (backend-level) one
 * can ever actually kill anything. Because the outer one holds the
 * concurrency slot, it passes `awaitOperationOnStop`: on abort or expiry it
 * keeps the slot until the inner call settles (bounded by
 * {@link stopSettleBoundMs}), so a slot is never handed to the next
 * delegation while the previous child is still being stopped.
 *
 * Each backend also has one or two genuinely synchronous helper spawns
 * (`shell-claude-cli-backend.ts`'s `probeShellClaudeCliAvailability` via
 * `spawnSync`, `codex-cli-query.ts`'s `resolveCodexBinary` via
 * `safeExecResult`/`execFileSync`) that are NOT part of any delegation's
 * wall-clock budget: they are one-shot preflight/discovery calls (find the
 * binary, health-check it), not the delegation's own unit of work, and a
 * synchronous call cannot be killed mid-flight from the same thread regardless
 * — they rely on their own short, hardcoded timeouts instead. See the
 * `// SYNC, NOT WALL-CLOCK-BUDGETED` comments at each call site.
 *
 * Orphans that outlive the in-process SIGTERM -> SIGKILL escalation (e.g. the
 * Kyberion process itself exited or restarted mid-grace-window) are addressed
 * by persisting whatever handle *is* registered to
 * `active/shared/runtime/delegation-children.json` (via the shared
 * schema-bound registry contract) and
 * reaping stale entries in `storage-janitor.ts`'s zombie sweep
 * (`sweepDelegationChildren`) — a separate maintenance pass that can run in a
 * later session even if the process that spawned the child has already
 * exited. `storage-janitor.ts` consumes the same contract rather than
 * importing this module's runtime dependencies.
 *
 * See docs/developer/improvement-plans-2026-07/
 * CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md §XP-06.
 */

import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { nowIso } from '../foundation/time.js';
import { Semaphore } from '../semaphore.js';
import { withDelegationProgress } from './delegation-progress.js';
import { logger } from '../core.js';
import { recordGovernanceAction } from '../governance/governance-action-recorder.js';
import { safeExecResult } from '../secure-io.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import {
  delegationChildrenRegistryPath as resolveDelegationChildrenRegistryPath,
  loadDelegationChildrenRegistryAtPath,
  writeDelegationChildrenRegistryAtPath,
  type DelegationChildRecord,
} from './delegation-child-registry.js';
export { DELEGATION_CHILDREN_REGISTRY_SUBPATH } from './delegation-child-registry.js';

const DEFAULT_GLOBAL_MAX_CONCURRENCY = 4;
const DEFAULT_PROVIDER_MAX_CONCURRENCY = 2;
const DEFAULT_WALL_CLOCK_MS = 10 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5000;
/** Slack over the inner SIGTERM + grace + SIGKILL + grace stop sequence. */
const STOP_SETTLE_MARGIN_MS = 1000;

/** Bucket shared by delegations whose provider could not be identified. */
export const UNKNOWN_DELEGATION_PROVIDER = 'unknown';

/** Relative path (under `active/shared/`) of the persisted active-child PID registry. */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function resolveGlobalCap(): number {
  return parsePositiveInt(
    getRegisteredEnvText('KYBERION_DELEGATION_MAX_CONCURRENCY'),
    DEFAULT_GLOBAL_MAX_CONCURRENCY
  );
}

function resolveUniformProviderCap(): number {
  return parsePositiveInt(
    getRegisteredEnvText('KYBERION_DELEGATION_PROVIDER_MAX_CONCURRENCY'),
    DEFAULT_PROVIDER_MAX_CONCURRENCY
  );
}

function resolveProviderCapOverrides(): Record<string, number> {
  const raw = getRegisteredEnvText('KYBERION_DELEGATION_PROVIDER_CAPS');
  if (!raw) return {};
  try {
    const parsed = parseSafeJsonInput(raw, 'delegation provider capabilities');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const overrides: Record<string, number> = {};
      for (const [provider, value] of Object.entries(parsed)) {
        if (Number.isInteger(value) && value > 0) overrides[provider] = value;
      }
      return overrides;
    }
  } catch (err) {
    logger.warn(
      `[delegation-concurrency] KYBERION_DELEGATION_PROVIDER_CAPS is not valid JSON (ignored): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return {};
}

function resolveProviderCap(provider: string): number {
  const overrides = resolveProviderCapOverrides();
  const override = overrides[provider];
  if (typeof override === 'number' && Number.isInteger(override) && override > 0) return override;
  return resolveUniformProviderCap();
}

function resolveWallClockBudgetMs(): number {
  return parsePositiveInt(
    getRegisteredEnvText('KYBERION_DELEGATION_WALL_CLOCK_MS'),
    DEFAULT_WALL_CLOCK_MS
  );
}

function resolveKillGraceMs(): number {
  return parsePositiveInt(
    getRegisteredEnvText('KYBERION_DELEGATION_KILL_GRACE_MS'),
    DEFAULT_KILL_GRACE_MS
  );
}

/**
 * How long a handle-less budget with `awaitOperationOnStop` waits for the
 * wrapped call to settle after an abort or expiry: the inner adapter's whole
 * stop sequence (SIGTERM, grace, SIGKILL, grace = 2 × grace) plus a margin.
 */
export function stopSettleBoundMs(graceMs: number = resolveKillGraceMs()): number {
  return 2 * graceMs + STOP_SETTLE_MARGIN_MS;
}

// --- concurrency semaphore -------------------------------------------------

interface SlotCounters {
  active: number;
  queued: number;
}

interface SlotState {
  semaphore: Semaphore;
  counters: SlotCounters;
  cap: number;
}

let globalState: SlotState | null = null;
const providerStates = new Map<string, SlotState>();

function getGlobalState(): SlotState {
  if (!globalState) {
    const cap = resolveGlobalCap();
    globalState = { semaphore: new Semaphore(cap), counters: { active: 0, queued: 0 }, cap };
  }
  return globalState;
}

function getProviderState(provider: string): SlotState {
  let state = providerStates.get(provider);
  if (!state) {
    const cap = resolveProviderCap(provider);
    state = { semaphore: new Semaphore(cap), counters: { active: 0, queued: 0 }, cap };
    providerStates.set(provider, state);
  }
  return state;
}

async function withSlot<T>(state: SlotState, fn: () => Promise<T>): Promise<T> {
  state.counters.queued += 1;
  return state.semaphore.run(async () => {
    state.counters.queued -= 1;
    state.counters.active += 1;
    try {
      return await fn();
    } finally {
      state.counters.active -= 1;
    }
  });
}

export interface DelegationSlotOptions {
  /** Provider id (e.g. 'claude' | 'codex' | 'agy'). Falls back to the shared 'unknown' bucket. */
  provider?: string;
}

/**
 * Acquire a global + per-provider concurrency slot before running `fn`,
 * queuing FIFO when either is saturated. Never rejects due to saturation —
 * only `fn` itself (once it finally runs) can reject.
 */
export function withDelegationSlot<T>(
  opts: DelegationSlotOptions,
  fn: () => Promise<T>
): Promise<T> {
  const provider = opts.provider?.trim() || UNKNOWN_DELEGATION_PROVIDER;
  const global = getGlobalState();
  const providerState = getProviderState(provider);
  return withSlot(global, () => withSlot(providerState, fn));
}

export interface DelegationConcurrencySlotStats {
  active: number;
  queued: number;
  cap: number;
}

export interface DelegationConcurrencyStats {
  global: DelegationConcurrencySlotStats;
  providers: Record<string, DelegationConcurrencySlotStats>;
}

/** Observability snapshot for tests/ops tooling — never mutates state. */
export function getDelegationConcurrencyStats(): DelegationConcurrencyStats {
  const global = getGlobalState();
  const providers: Record<string, DelegationConcurrencySlotStats> = {};
  for (const [provider, state] of providerStates) {
    providers[provider] = {
      active: state.counters.active,
      queued: state.counters.queued,
      cap: state.cap,
    };
  }
  return {
    global: { active: global.counters.active, queued: global.counters.queued, cap: global.cap },
    providers,
  };
}

// --- wall-clock budget + active-child registry -----------------------------

/** Minimal handle a caller can supply to make a wall-clock timeout actually killable. */
export interface DelegationChildHandle {
  pid?: number;
  kill(signal: NodeJS.Signals): void;
  /**
   * Settles when the child process has exited. With it, an explicit abort
   * waits (bounded) for the child to exit before rejecting, so the rejection
   * proves the process stopped; without it the exit is not observable.
   */
  exited?: Promise<void>;
}

/**
 * Adapt a real `node:child_process` `ChildProcess` (as returned by `spawn`)
 * into a {@link DelegationChildHandle}. Structurally typed (not `import type
 * { ChildProcess }`) so this module stays free of a hard `node:child_process`
 * dependency — callers pass their already-spawned child as-is. Shared by the
 * three CLI backends' `spawnCli` so the `{ pid, kill }` extraction has one
 * definition instead of three.
 */
export function delegationChildHandleFromChildProcess(child: {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | string | null;
  once?(event: 'exit', listener: (...args: unknown[]) => void): unknown;
}): DelegationChildHandle {
  // Subscribe at construction (right after spawn) so an exit that happens
  // before an abort is not missed; an already-exited child settles at once.
  const exited =
    typeof child.once === 'function'
      ? new Promise<void>((resolve) => {
          if (
            (child.exitCode !== undefined && child.exitCode !== null) ||
            (child.signalCode !== undefined && child.signalCode !== null)
          ) {
            resolve();
            return;
          }
          child.once!('exit', () => resolve());
        })
      : undefined;
  return {
    pid: child.pid,
    kill: (signal: NodeJS.Signals) => {
      child.kill(signal);
    },
    ...(exited ? { exited } : {}),
  };
}

export type { DelegationChildRecord } from './delegation-child-registry.js';

interface ActiveChildEntry {
  record: DelegationChildRecord;
  handle: DelegationChildHandle;
}

const activeChildren = new Map<string, ActiveChildEntry>();
let idCounter = 0;

function delegationChildrenRegistryPath(): string {
  return resolveDelegationChildrenRegistryPath();
}

function readPersistedRegistry(): DelegationChildRecord[] {
  try {
    const filePath = delegationChildrenRegistryPath();
    return loadDelegationChildrenRegistryAtPath(filePath);
  } catch {
    return [];
  }
}

function writePersistedRegistry(records: DelegationChildRecord[]): void {
  try {
    writeDelegationChildrenRegistryAtPath(records, delegationChildrenRegistryPath());
  } catch (err) {
    logger.warn(
      `[delegation-concurrency] failed to persist active-child registry (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function resolveProcessStartTime(pid: number | undefined): string | undefined {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return undefined;
  try {
    const result = safeExecResult('ps', ['-p', String(pid), '-o', 'lstart='], {
      timeoutMs: 1000,
      maxOutputMB: 1,
    });
    const parsed = Date.parse(result.stdout.trim());
    return result.status === 0 && Number.isFinite(parsed)
      ? new Date(parsed).toISOString()
      : undefined;
  } catch {
    // If process identity cannot be established, the janitor will fail closed
    // and leave the record visible for a later sweep.
    return undefined;
  }
}

/** Test/ops-only: read the persisted active-child registry as-is. */
export function peekPersistedDelegationChildrenRegistry(): DelegationChildRecord[] {
  return readPersistedRegistry();
}

function registerActiveChild(record: DelegationChildRecord, handle: DelegationChildHandle): void {
  activeChildren.set(record.id, { record, handle });
  const records = readPersistedRegistry().filter((r) => r.id !== record.id);
  records.push(record);
  writePersistedRegistry(records);
}

function unregisterActiveChild(id: string): void {
  if (!activeChildren.delete(id)) return;
  const records = readPersistedRegistry();
  const next = records.filter((r) => r.id !== id);
  if (next.length !== records.length) writePersistedRegistry(next);
}

function safeKillChild(handle: DelegationChildHandle, signal: NodeJS.Signals): void {
  try {
    handle.kill(signal);
  } catch (err) {
    logger.warn(
      `[delegation-concurrency] child.kill(${signal}) failed (non-fatal, likely already exited): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export interface DelegationTimeoutRecord {
  id: string;
  provider: string;
  budgetMs: number;
  at: string;
}

const recordedTimeouts: DelegationTimeoutRecord[] = [];
/** In-process cancellation listeners also cover native sessions with no child handle. */
const activeDelegationAborts = new Set<() => void>();

/** Test/ops-only: recorded wall-clock timeouts since the last reset. */
export function getRecordedDelegationTimeouts(): DelegationTimeoutRecord[] {
  return recordedTimeouts.slice();
}

function recordDelegationTimeout(provider: string, budgetMs: number, id: string): void {
  recordedTimeouts.push({ id, provider, budgetMs, at: nowIso() });
  logger.warn(
    `[delegation-concurrency] provider='${provider}' delegation id=${id} exceeded wall-clock budget of ${budgetMs}ms`
  );
  // Best-effort: feed the same governance ledger the kill-switch anomaly
  // detector reads (policy_violations), so repeated timeouts for the same
  // logical actor can themselves escalate through the existing graduated
  // response (warn -> isolate -> kill) without a second detector.
  recordGovernanceAction(
    'delegation-concurrency',
    'wall_clock_timeout',
    `provider=${provider} id=${id} budgetMs=${budgetMs}`,
    true
  );
}

export class DelegationWallClockExceededError extends Error {
  readonly provider: string;
  readonly budgetMs: number;
  constructor(provider: string, budgetMs: number) {
    super(`delegation to provider '${provider}' exceeded wall-clock budget of ${budgetMs}ms`);
    this.name = 'DelegationWallClockExceededError';
    this.provider = provider;
    this.budgetMs = budgetMs;
  }
}

/**
 * What an explicit abort observed of the delegation's child process:
 * - `exited`: the child exited within the bounded wait (after SIGTERM, or
 *   after the SIGKILL escalation);
 * - `not_exited`: the child was still running after SIGTERM, the grace
 *   window, SIGKILL and a second grace window;
 * - `unobservable`: a child was signalled but its handle exposes no exit;
 * - `no_child`: the delegation had no child process handle;
 * - `unconfirmed`: a handle-less wrapper waited (`awaitOperationOnStop`) for
 *   the wrapped call to settle and it had not within the bound, so whether
 *   the child below it stopped is not known.
 */
export type DelegationAbortChildExit =
  'exited' | 'not_exited' | 'unobservable' | 'no_child' | 'unconfirmed';

const CHILD_EXIT_MARKER = /\(child_exit=(exited|not_exited|unobservable|no_child|unconfirmed)\b/u;

/**
 * Rejection of an explicitly aborted delegation. The message keeps the
 * `[DELEGATION_CANCELLED] provider operation aborted` prefix every caller
 * classifies on, plus a `(child_exit=…)` marker so the observation survives
 * adapters that re-wrap errors by message.
 */
export class DelegationAbortedError extends Error {
  readonly childExit: DelegationAbortChildExit;
  readonly signal?: NodeJS.Signals;
  constructor(
    childExit: DelegationAbortChildExit,
    detail: { signal?: NodeJS.Signals; graceMs?: number; waitedMs?: number } = {}
  ) {
    const observed =
      childExit === 'exited'
        ? `child exited after ${detail.signal ?? 'SIGTERM'}`
        : childExit === 'not_exited'
          ? `child still running ${detail.graceMs ?? 0}ms after SIGKILL`
          : childExit === 'unobservable'
            ? 'child signalled; its exit is not observable'
            : childExit === 'unconfirmed'
              ? `the wrapped call had not settled ${detail.waitedMs ?? 0}ms after the abort`
              : 'no child process';
    super(
      `[DELEGATION_CANCELLED] provider operation aborted (child_exit=${childExit}: ${observed})`
    );
    this.name = 'DelegationAbortedError';
    this.childExit = childExit;
    if (detail.signal) this.signal = detail.signal;
  }
}

/** The child-exit observation an abort rejection carries, if any. */
export function delegationAbortChildExit(error: unknown): DelegationAbortChildExit | undefined {
  if (error instanceof DelegationAbortedError) return error.childExit;
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = CHILD_EXIT_MARKER.exec(text);
  return match ? (match[1] as DelegationAbortChildExit) : undefined;
}

type OperationSettlement = { ok: true } | { ok: false; error: unknown };

/** The settlement of `settled` if it arrives within `ms`, else undefined; leaves no timer behind. */
async function settlementWithin(
  settled: Promise<OperationSettlement>,
  ms: number
): Promise<OperationSettlement | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Resolve true when `exited` settles within `ms`, false otherwise; leaves no timer behind. */
async function childExitedWithin(exited: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Stop an explicitly aborted delegation's child and report what was observed.
 * SIGTERM, wait up to `graceMs` for exit, escalate to SIGKILL, wait up to
 * `graceMs` again. A handle without `exited` keeps the previous
 * fire-and-forget escalation and reports `unobservable`.
 */
async function stopChildAfterAbort(
  child: DelegationChildHandle,
  graceMs: number,
  id: string
): Promise<DelegationAbortedError> {
  safeKillChild(child, 'SIGTERM');
  const exited = child.exited;
  if (!exited) {
    const sigkillTimer = setTimeout(() => {
      safeKillChild(child, 'SIGKILL');
      unregisterActiveChild(id);
    }, graceMs);
    sigkillTimer.unref?.();
    return new DelegationAbortedError('unobservable');
  }
  if (await childExitedWithin(exited, graceMs)) {
    unregisterActiveChild(id);
    return new DelegationAbortedError('exited', { signal: 'SIGTERM' });
  }
  safeKillChild(child, 'SIGKILL');
  if (await childExitedWithin(exited, graceMs)) {
    unregisterActiveChild(id);
    return new DelegationAbortedError('exited', { signal: 'SIGKILL' });
  }
  logger.warn(
    `[delegation-concurrency] aborted delegation child did not exit — still running ${graceMs}ms after SIGKILL | next: inspect pid ${child.pid ?? 'unknown'}; the active-child registry keeps it for the janitor sweep | evidence: id=${id}`
  );
  // Still running: it stays registered until it exits (or the janitor sweeps it).
  void exited.then(() => unregisterActiveChild(id));
  return new DelegationAbortedError('not_exited', { graceMs });
}

export class DelegationInactivityExceededError extends Error {
  constructor(
    readonly provider: string,
    readonly timeoutMs: number
  ) {
    super(`delegation to provider '${provider}' made no semantic progress for ${timeoutMs}ms`);
    this.name = 'DelegationInactivityExceededError';
  }
}

export interface WithWallClockBudgetOptions {
  provider?: string;
  /** Default `KYBERION_DELEGATION_WALL_CLOCK_MS` (10 minutes). */
  budgetMs?: number;
  /** SIGTERM -> SIGKILL grace window. Default `KYBERION_DELEGATION_KILL_GRACE_MS` (5s). */
  killGraceMs?: number;
  /** Killable handle for the child this call represents, if the caller has one. Omit when unavailable — the budget still times out and records, it just cannot forcibly kill. */
  child?: DelegationChildHandle;
  /** Stable id for registry/records. Defaults to an internal counter keyed by provider. */
  id?: string;
  /** AbortSignal for explicit delegation cancellation. */
  signal?: AbortSignal;
  /** Opt-in semantic progress timeout. Transport output does not reset it. */
  inactivity?: { timeoutMs: number; lateResultGraceMs?: number };
  executionMode?: 'bounded' | 'continuous';
  /**
   * Only for a budget WITHOUT `child` that wraps a call which has one (the
   * dispatcher-level budget in `agent-dispatch.ts`). On explicit abort or
   * wall-clock expiry, keep this call pending until `fn` settles — bounded by
   * {@link stopSettleBoundMs} (2 × `killGraceMs` + margin) — instead of
   * rejecting at once, so a concurrency slot held around it stays held while
   * the inner adapter stops its child. The abort rejection is then the
   * provider's own (`child_exit=exited|not_exited|…`) when `fn` rejected with
   * one, `no_child` when `fn` settled without one, and `unconfirmed` after the
   * bound. Expiry still rejects with {@link DelegationWallClockExceededError}.
   * Ignored when `child` is supplied (that path already waits for the exit).
   */
  awaitOperationOnStop?: boolean;
}

/**
 * Race `fn()` against a wall-clock budget. On expiry: record the timeout,
 * escalate SIGTERM -> (after `killGraceMs`) SIGKILL against `child` if one
 * was supplied, and reject with {@link DelegationWallClockExceededError}.
 * `fn()` itself is never cancelled (JS has no true cancellation) — this
 * abandons the wait, it does not stop `fn` from eventually settling on its
 * own in the background.
 */
export async function withWallClockBudget<T>(
  opts: WithWallClockBudgetOptions,
  fn: (signal: AbortSignal, canAcceptResult: () => boolean) => Promise<T>
): Promise<T> {
  if (opts.signal?.aborted) throw new Error('[DELEGATION_CANCELLED] provider operation aborted');
  const provider = opts.provider?.trim() || UNKNOWN_DELEGATION_PROVIDER;
  const budgetMs = opts.budgetMs ?? resolveWallClockBudgetMs();
  const graceMs = opts.killGraceMs ?? resolveKillGraceMs();
  const id = opts.id ?? `${provider}-${++idCounter}`;
  const inactivity = opts.inactivity;
  if (opts.executionMode === 'continuous' && !inactivity) {
    throw new Error('Continuous delegation requires semantic inactivity supervision');
  }
  if (
    inactivity &&
    (![inactivity.timeoutMs, inactivity.lateResultGraceMs ?? 2000].every(
      (n) => Number.isSafeInteger(n) && n >= 0 && n <= 2_147_483_647
    ) ||
      inactivity.timeoutMs === 0)
  ) {
    throw new Error('Invalid delegation inactivity timeout/grace');
  }
  const controller = new AbortController();

  if (opts.child) {
    const now = Date.now();
    const childLeaseMs =
      opts.executionMode === 'continuous'
        ? inactivity!.timeoutMs + (inactivity!.lateResultGraceMs ?? 2000)
        : budgetMs;
    const pidStartedAt = resolveProcessStartTime(opts.child.pid);
    registerActiveChild(
      {
        id,
        provider,
        pid: opts.child.pid,
        startedAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + childLeaseMs).toISOString(),
        budgetMs: childLeaseMs,
        ...(pidStartedAt ? { pidStartedAt } : {}),
      },
      opts.child
    );
  }

  let timedOut = false;
  let sigtermTimer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let killListener: (() => void) | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let lateTimer: ReturnType<typeof setTimeout> | undefined;
  let inactive = false;
  let terminal = false;
  let armInactivity = () => {};
  let abortOutcome: Promise<Error> | undefined;
  let expiryOutcome: Promise<Error> | undefined;
  // Handle-less wrapper of a call that owns a child: wait for that call on stop.
  const awaitOperation = Boolean(opts.awaitOperationOnStop && !opts.child);
  const settleBoundMs = stopSettleBoundMs(graceMs);
  let notifySettled: (settlement: OperationSettlement) => void = () => {};
  const operationSettled = new Promise<OperationSettlement>((resolve) => {
    notifySettled = resolve;
  });
  const abortAfterOperationSettles = async (): Promise<Error> => {
    const settlement = await settlementWithin(operationSettled, settleBoundMs);
    if (!settlement) return new DelegationAbortedError('unconfirmed', { waitedMs: settleBoundMs });
    // The provider's own observation of its child, never one made up here.
    if (!settlement.ok && delegationAbortChildExit(settlement.error)) {
      return settlement.error instanceof Error
        ? settlement.error
        : new Error(String(settlement.error));
    }
    return new DelegationAbortedError('no_child');
  };

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    killListener = () => {
      terminal = true;
      timedOut = true;
      controller.abort();
      reject(new Error('[DELEGATION_CANCELLED] delegation terminated by kill switch'));
    };
    activeDelegationAborts.add(killListener);
    if (opts.executionMode !== 'continuous') {
      sigtermTimer = setTimeout(() => {
        terminal = true;
        timedOut = true;
        controller.abort();
        recordDelegationTimeout(provider, budgetMs, id);
        const child = opts.child;
        if (child) {
          safeKillChild(child, 'SIGTERM');
          const sigkillTimer = setTimeout(() => {
            safeKillChild(child, 'SIGKILL');
            unregisterActiveChild(id);
          }, graceMs);
          sigkillTimer.unref?.();
        }
        const exceeded = new DelegationWallClockExceededError(provider, budgetMs);
        if (awaitOperation) {
          expiryOutcome = settlementWithin(operationSettled, settleBoundMs).then(() => exceeded);
          void expiryOutcome.then(reject);
        } else reject(exceeded);
      }, budgetMs);
      sigtermTimer.unref?.();
    }
    if (opts.signal) {
      abortListener = () => {
        terminal = true;
        timedOut = true;
        controller.abort();
        // Reject only once the child is shown stopped (bounded by the
        // SIGTERM/SIGKILL grace windows), so an abort rejection means the
        // process exited, not merely that stopping started.
        abortOutcome = opts.child
          ? stopChildAfterAbort(opts.child, graceMs, id)
          : awaitOperation
            ? abortAfterOperationSettles()
            : Promise.resolve(new DelegationAbortedError('no_child'));
        void abortOutcome.then(reject);
      };
      if (opts.signal.aborted) abortListener();
      else opts.signal.addEventListener('abort', abortListener, { once: true });
    }
    if (inactivity) {
      armInactivity = () => {
        if (inactive || terminal) return;
        if (opts.executionMode === 'continuous' && opts.child) {
          const entry = activeChildren.get(id);
          if (entry)
            registerActiveChild(
              {
                ...entry.record,
                deadlineAt: new Date(
                  Date.now() + inactivity.timeoutMs + (inactivity.lateResultGraceMs ?? 2000)
                ).toISOString(),
              },
              entry.handle
            );
        }
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          inactive = true;
          // A cooperative stop may produce a real final result during this
          // short grace; cancellation and hard timeout remain terminal.
          controller.abort();
          lateTimer = setTimeout(() => {
            terminal = true;
            timedOut = true;
            if (opts.child) {
              safeKillChild(opts.child, 'SIGTERM');
              const sigkillTimer = setTimeout(() => {
                safeKillChild(opts.child!, 'SIGKILL');
                unregisterActiveChild(id);
              }, graceMs);
              sigkillTimer.unref?.();
            }
            reject(new DelegationInactivityExceededError(provider, inactivity.timeoutMs));
          }, inactivity.lateResultGraceMs ?? 2000);
          lateTimer.unref?.();
        }, inactivity.timeoutMs);
        idleTimer.unref?.();
      };
      armInactivity();
    }
  });

  try {
    const operation = withDelegationProgress(
      armInactivity,
      () => fn(controller.signal, () => !terminal && !opts.signal?.aborted),
      opts.executionMode
    );
    operation.then(
      () => notifySettled({ ok: true }),
      (error: unknown) => notifySettled({ ok: false, error })
    );
    const result = await Promise.race([operation, timeoutPromise]);
    // The child closing after SIGTERM can settle fn first: report the abort.
    if (abortOutcome) throw await abortOutcome;
    if (expiryOutcome) throw await expiryOutcome;
    // A synchronous abort listener can settle fn before the race rejection.
    if (terminal || opts.signal?.aborted) {
      throw new Error('[DELEGATION_CANCELLED] result arrived after terminal cancellation');
    }
    return result;
  } catch (error) {
    // An aborted child exiting makes fn reject ("exited with code null") while
    // the abort still waits on the exit; the abort observation is the answer.
    if (abortOutcome && !(error instanceof DelegationAbortedError)) throw await abortOutcome;
    if (expiryOutcome) throw await expiryOutcome;
    if (inactive && !terminal) {
      terminal = true;
      timedOut = true;
      if (opts.child) {
        safeKillChild(opts.child, 'SIGTERM');
        const sigkillTimer = setTimeout(() => {
          safeKillChild(opts.child!, 'SIGKILL');
          unregisterActiveChild(id);
        }, graceMs);
        sigkillTimer.unref?.();
      }
      throw new DelegationInactivityExceededError(provider, inactivity!.timeoutMs);
    }
    throw error;
  } finally {
    terminal = true;
    if (sigtermTimer) clearTimeout(sigtermTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (lateTimer) clearTimeout(lateTimer);
    if (opts.signal && abortListener) opts.signal.removeEventListener('abort', abortListener);
    if (killListener) activeDelegationAborts.delete(killListener);
    // On the timeout path, the SIGKILL escalation above owns unregistration
    // (it must stay tracked through the grace window). On any other settle
    // path (success or a normal `fn()` rejection), clean up immediately.
    if (opts.child && !timedOut) unregisterActiveChild(id);
  }
}

/**
 * Kill-switch cascade: terminate every currently-registered active
 * delegation child (SIGTERM now, SIGKILL after the grace window). Exported
 * standalone so callers/tests can invoke it directly without going through
 * the kill-switch wiring below.
 */
export function terminateAllActiveDelegationChildren(reason: string): { terminatedIds: string[] } {
  const graceMs = resolveKillGraceMs();
  const terminatedIds: string[] = [];
  for (const abort of activeDelegationAborts) abort();
  for (const [id, entry] of activeChildren) {
    terminatedIds.push(id);
    logger.warn(
      `[delegation-concurrency] terminating active delegation child id=${id} provider=${entry.record.provider} (reason: ${reason})`
    );
    safeKillChild(entry.handle, 'SIGTERM');
    const handle = entry.handle;
    const sigkillTimer = setTimeout(() => {
      safeKillChild(handle, 'SIGKILL');
      unregisterActiveChild(id);
    }, graceMs);
    sigkillTimer.unref?.();
  }
  return { terminatedIds };
}

type KillSwitchTerminationListener = (agentId: string, reason: string) => void;
type KillSwitchTerminationRegistrar = (listener: KillSwitchTerminationListener) => () => void;

let killSwitchTerminationRegistrar: KillSwitchTerminationRegistrar | undefined;
let killSwitchTerminationDisposer: (() => void) | null = null;
let killSwitchWiringRequested = false;

/**
 * Register the optional kill-switch listener seam. The kill-switch module is
 * the owner of the termination event; delegation-concurrency only supplies
 * the callback, keeping this resource-governance module independent of the
 * kill-switch dependency graph.
 */
export function registerKillSwitchTerminationRegistrar(
  registrar: KillSwitchTerminationRegistrar
): () => void {
  killSwitchTerminationRegistrar = registrar;
  if (killSwitchWiringRequested) installKillSwitchTerminationListener();
  return () => {
    if (killSwitchTerminationRegistrar !== registrar) return;
    killSwitchTerminationDisposer?.();
    killSwitchTerminationDisposer = null;
    killSwitchTerminationRegistrar = undefined;
  };
}

function installKillSwitchTerminationListener(): void {
  if (killSwitchTerminationDisposer || !killSwitchTerminationRegistrar) return;
  killSwitchTerminationDisposer = killSwitchTerminationRegistrar((agentId, reason) => {
    terminateAllActiveDelegationChildren(`kill-switch:${agentId}:${reason}`);
  });
}

/**
 * Request registration of {@link terminateAllActiveDelegationChildren} as a
 * kill-switch termination listener. Idempotent and safe to call from every
 * dispatch. The owner module registers the registrar separately, so this
 * module never imports kill-switch and cannot form a runtime cycle with it.
 */
export function wireDelegationKillSwitchIntegration(): Promise<void> {
  killSwitchWiringRequested = true;
  installKillSwitchTerminationListener();
  return Promise.resolve();
}

/** Test-only: reset every module-level singleton (semaphores, counters, registries, wiring memo). */
export function resetDelegationConcurrencyStateForTests(): void {
  globalState = null;
  providerStates.clear();
  activeChildren.clear();
  activeDelegationAborts.clear();
  recordedTimeouts.length = 0;
  idCounter = 0;
  killSwitchTerminationDisposer?.();
  killSwitchTerminationDisposer = null;
  killSwitchTerminationRegistrar = undefined;
  killSwitchWiringRequested = false;
}
