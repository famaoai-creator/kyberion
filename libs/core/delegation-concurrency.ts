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
 * IMPORTANT SCOPE NOTE: the three CLI backends (`shell-claude-cli-backend.ts`,
 * `codex-cli-query.ts`, `agy-cli-backend.ts`) spawn their child processes
 * internally and do not currently return a handle to the caller — the
 * `agent-dispatch.ts` choke point that wires this module therefore cannot
 * pass a real {@link DelegationChildHandle} yet, so in production today the
 * wall-clock budget can abandon-and-record a hung delegation but cannot
 * forcibly kill the underlying OS process. `withWallClockBudget` and the
 * active-child registry are fully general (see the hermetic tests, which
 * inject fake handles) and ready for the day a backend exposes one. Real
 * orphans in the meantime are addressed by persisting whatever handle *is*
 * registered to `active/shared/runtime/delegation-children.json` (via
 * secure-io) and reaping stale entries in `storage-janitor.ts`'s zombie
 * sweep — a separate maintenance pass that can run in a later session even
 * if the process that spawned the child has already exited.
 *
 * See docs/developer/improvement-plans-2026-07/
 * CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md §XP-06.
 */
import * as path from 'node:path';
import { Semaphore } from './semaphore.js';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';

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
    process.env.KYBERION_DELEGATION_MAX_CONCURRENCY,
    DEFAULT_GLOBAL_MAX_CONCURRENCY
  );
}

function resolveUniformProviderCap(): number {
  return parsePositiveInt(
    process.env.KYBERION_DELEGATION_PROVIDER_MAX_CONCURRENCY,
    DEFAULT_PROVIDER_MAX_CONCURRENCY
  );
}

function resolveProviderCapOverrides(): Record<string, number> {
  const raw = process.env.KYBERION_DELEGATION_PROVIDER_CAPS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
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
  return parsePositiveInt(process.env.KYBERION_DELEGATION_WALL_CLOCK_MS, DEFAULT_WALL_CLOCK_MS);
}

function resolveKillGraceMs(): number {
  return parsePositiveInt(process.env.KYBERION_DELEGATION_KILL_GRACE_MS, DEFAULT_KILL_GRACE_MS);
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

export interface DelegationChildRecord {
  id: string;
  provider: string;
  pid?: number;
  startedAt: string;
  deadlineAt: string;
  budgetMs: number;
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
    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw);
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
  recordedTimeouts.push({ id, provider, budgetMs, at: new Date().toISOString() });
  logger.warn(
    `[delegation-concurrency] provider='${provider}' delegation id=${id} exceeded wall-clock budget of ${budgetMs}ms`
  );
  // Best-effort: feed the same governance ledger the kill-switch anomaly
  // detector reads (policy_violations), so repeated timeouts for the same
  // logical actor can themselves escalate through the existing graduated
  // response (warn -> isolate -> kill) without a second detector.
  import('./kill-switch.js')
    .then(({ recordGovernanceAction }) => {
      recordGovernanceAction(
        'delegation-concurrency',
        'wall_clock_timeout',
        `provider=${provider} id=${id} budgetMs=${budgetMs}`,
        true
      );
    })
    .catch((err) => {
      logger.warn(
        `[delegation-concurrency] failed to record governance action for timeout (non-fatal): ${err instanceof Error ? err.message : String(err)}`
      );
    });
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
    registerActiveChild(
      {
        id,
        provider,
        pid: opts.child.pid,
        startedAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + budgetMs).toISOString(),
        budgetMs,
      },
      opts.child
    );
  }

  let timedOut = false;
  let sigtermTimer: ReturnType<typeof setTimeout> | undefined;

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
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (sigtermTimer) clearTimeout(sigtermTimer);
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

let killSwitchWirePromise: Promise<void> | null = null;

/**
 * Register {@link terminateAllActiveDelegationChildren} as a kill-switch
 * termination listener (dynamic import — mirrors the existing
 * `kill-switch.js` lazy-import pattern elsewhere in this repo, and keeps
 * importing *this* module free of side effects). Idempotent and memoized:
 * safe to call from every dispatch, only wires once. Returns the wiring
 * promise so tests can await it deterministically; production callers may
 * fire-and-forget.
 */
export function wireDelegationKillSwitchIntegration(): Promise<void> {
  if (killSwitchWirePromise) return killSwitchWirePromise;
  killSwitchWirePromise = import('./kill-switch.js')
    .then(({ onKillSwitchTermination }) => {
      onKillSwitchTermination((agentId, reason) => {
        terminateAllActiveDelegationChildren(`kill-switch:${agentId}:${reason}`);
      });
    })
    .catch((err) => {
      logger.warn(
        `[delegation-concurrency] failed to wire kill-switch integration (non-fatal): ${err instanceof Error ? err.message : String(err)}`
      );
      killSwitchWirePromise = null; // allow a later call to retry
    });
  return killSwitchWirePromise;
}

/** Test-only: reset every module-level singleton (semaphores, counters, registries, wiring memo). */
export function resetDelegationConcurrencyStateForTests(): void {
  globalState = null;
  providerStates.clear();
  activeChildren.clear();
  recordedTimeouts.length = 0;
  idCounter = 0;
  killSwitchWirePromise = null;
}
