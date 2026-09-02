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
 * can ever actually kill anything.
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
 * `active/shared/runtime/delegation-children.json` (via secure-io) and
 * reaping stale entries in `storage-janitor.ts`'s zombie sweep
 * (`sweepDelegationChildren`) — a separate maintenance pass that can run in a
 * later session even if the process that spawned the child has already
 * exited. `storage-janitor.ts` deliberately duplicates the
 * `DelegationChildRecord` shape (see its own comment) rather than importing
 * this module; `delegation-concurrency.test.ts`'s
 * "producer/consumer shape drift" test keeps the two definitions honest.
 *
 * See docs/developer/improvement-plans-2026-07/
 * CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md §XP-06.
 */

import { parseSafeJsonInput } from './foundation/safe-json.js';
import { nowIso } from './foundation/time.js';
import * as path from 'node:path';
import { Semaphore } from './semaphore.js';
import { logger } from './core.js';
import { readJson } from './foundation/json.js';
import { recordGovernanceAction } from './governance-action-recorder.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeExecResult, safeMkdir, safeWriteFile } from './secure-io.js';
import { getRegisteredEnvText } from './foundation/env.js';

const DEFAULT_GLOBAL_MAX_CONCURRENCY = 4;
const DEFAULT_PROVIDER_MAX_CONCURRENCY = 2;
const DEFAULT_WALL_CLOCK_MS = 10 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5000;

/** Bucket shared by delegations whose provider could not be identified. */
export const UNKNOWN_DELEGATION_PROVIDER = 'unknown';

/** Relative path (under `active/shared/`) of the persisted active-child PID registry. Kept in sync with `storage-janitor.ts`'s zombie sweep. */
export const DELEGATION_CHILDREN_REGISTRY_SUBPATH = 'runtime/delegation-children.json';

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
}): DelegationChildHandle {
  return {
    pid: child.pid,
    kill: (signal: NodeJS.Signals) => {
      child.kill(signal);
    },
  };
}

export interface DelegationChildRecord {
  id: string;
  provider: string;
  pid?: number;
  startedAt: string;
  deadlineAt: string;
  budgetMs: number;
  /** OS process start time, used to prevent PID-reuse kills after a restart. */
  pidStartedAt?: string;
}

interface ActiveChildEntry {
  record: DelegationChildRecord;
  handle: DelegationChildHandle;
}

const activeChildren = new Map<string, ActiveChildEntry>();
let idCounter = 0;

function delegationChildrenRegistryPath(): string {
  return pathResolver.shared(DELEGATION_CHILDREN_REGISTRY_SUBPATH);
}

function readPersistedRegistry(): DelegationChildRecord[] {
  try {
    const filePath = delegationChildrenRegistryPath();
    if (!safeExistsSync(filePath)) return [];
    const parsed = readJson<unknown>(filePath);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePersistedRegistry(records: DelegationChildRecord[]): void {
  try {
    const filePath = delegationChildrenRegistryPath();
    const dir = path.dirname(filePath);
    if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
    safeWriteFile(filePath, JSON.stringify(records, null, 2), { encoding: 'utf8' });
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
  fn: () => Promise<T>
): Promise<T> {
  const provider = opts.provider?.trim() || UNKNOWN_DELEGATION_PROVIDER;
  const budgetMs = opts.budgetMs ?? resolveWallClockBudgetMs();
  const graceMs = opts.killGraceMs ?? resolveKillGraceMs();
  const id = opts.id ?? `${provider}-${++idCounter}`;

  if (opts.child) {
    const now = Date.now();
    const pidStartedAt = resolveProcessStartTime(opts.child.pid);
    registerActiveChild(
      {
        id,
        provider,
        pid: opts.child.pid,
        startedAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + budgetMs).toISOString(),
        budgetMs,
        ...(pidStartedAt ? { pidStartedAt } : {}),
      },
      opts.child
    );
  }

  let timedOut = false;
  let sigtermTimer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    sigtermTimer = setTimeout(() => {
      timedOut = true;
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
      reject(new DelegationWallClockExceededError(provider, budgetMs));
    }, budgetMs);
    sigtermTimer.unref?.();
    if (opts.signal) {
      abortListener = () => {
        timedOut = true;
        if (opts.child) {
          safeKillChild(opts.child, 'SIGTERM');
          const sigkillTimer = setTimeout(() => {
            safeKillChild(opts.child!, 'SIGKILL');
            unregisterActiveChild(id);
          }, graceMs);
          sigkillTimer.unref?.();
        }
        reject(new Error('[DELEGATION_CANCELLED] provider operation aborted'));
      };
      if (opts.signal.aborted) abortListener();
      else opts.signal.addEventListener('abort', abortListener, { once: true });
    }
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (sigtermTimer) clearTimeout(sigtermTimer);
    if (opts.signal && abortListener) opts.signal.removeEventListener('abort', abortListener);
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
  recordedTimeouts.length = 0;
  idCounter = 0;
  killSwitchTerminationDisposer?.();
  killSwitchTerminationDisposer = null;
  killSwitchTerminationRegistrar = undefined;
  killSwitchWiringRequested = false;
}
