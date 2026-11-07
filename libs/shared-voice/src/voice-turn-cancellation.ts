/**
 * Single-token cancellation for a voice turn (EV-02).
 *
 * Binds inference, TTS, STT feed, and trace consumers to one handle per
 * turn so a barge-in / EOT-revoke / timeout / external abort always fans
 * out the same way, instead of each consumer growing its own ad-hoc
 * cancellation surface. Design reference (read-only, not copied):
 * elizaOS `voice-cancellation-contract.md` + `voice-cancellation-token.ts`.
 *
 * Pure + injectable clock/timer — no globals, no real timers in tests.
 */

export type VoiceTurnCancelReason =
  'barge_in' | 'eot_revoked' | 'user_cancel' | 'timeout' | 'external';

export interface VoiceTurnCancellationToken {
  readonly turnId: string;
  readonly aborted: boolean;
  readonly reason: VoiceTurnCancelReason | null;
  readonly signal: AbortSignal;
  abort(reason: VoiceTurnCancelReason): void;
  onAbort(listener: (reason: VoiceTurnCancelReason) => void): () => void;
}

export interface VoiceTurnCancellationCoordinatorOptions {
  /** Schedule the budget timer (injectable for deterministic tests). */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** Clear a timer previously returned by `setTimer`. */
  clearTimer?: (handle: unknown) => void;
}

export interface ArmOptions {
  /** Milliseconds after which an un-aborted turn auto-aborts with 'timeout'. */
  budgetMs?: number;
  /** Per-arm override for the timer functions (falls back to coordinator defaults). */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function createToken(turnId: string, disposeTimer: () => void): VoiceTurnCancellationToken {
  const controller = new AbortController();
  const listeners = new Set<(reason: VoiceTurnCancelReason) => void>();
  let reason: VoiceTurnCancelReason | null = null;

  const token: VoiceTurnCancellationToken = {
    turnId,
    get aborted() {
      return reason !== null;
    },
    get reason() {
      return reason;
    },
    get signal() {
      return controller.signal;
    },
    abort(nextReason: VoiceTurnCancelReason) {
      // Idempotent — the first reason wins, later abort() calls are no-ops.
      if (reason !== null) return;
      reason = nextReason;
      disposeTimer();
      controller.abort();
      for (const listener of listeners) listener(nextReason);
    },
    onAbort(listener: (r: VoiceTurnCancelReason) => void) {
      // A listener registered AFTER abort() fires synchronously with the
      // recorded reason, so late subscribers never miss the event.
      if (reason !== null) {
        listener(reason);
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return token;
}

/**
 * Owns the single live cancellation token per turn. `arm()` creates a new
 * token for `turnId`; `abortCurrent()` / `current()` operate on whichever
 * token was armed most recently.
 *
 * Design choice — arming a new turn does NOT abort the previous turn's
 * token. The coordinator is a thin per-process registry, not a turn-taking
 * policy: a caller that wants "starting turn B cancels turn A" (e.g. a
 * barge-in) must call `abortCurrent()` (or `token.abort()` on the specific
 * token) itself before/while arming the next turn. `arm()` only disposes
 * the previous token's pending budget timer (it would otherwise leak and
 * could fire a stale 'timeout' abort against a token nobody holds a
 * reference to any more) — it does not touch the previous token's abort
 * state or listeners.
 */
export class VoiceTurnCancellationCoordinator {
  private readonly setTimerDefault: (cb: () => void, ms: number) => unknown;
  private readonly clearTimerDefault: (handle: unknown) => void;
  private activeToken: VoiceTurnCancellationToken | null = null;
  private activeTimer: unknown = null;
  private activeClearTimer: ((handle: unknown) => void) | null = null;

  constructor(options: VoiceTurnCancellationCoordinatorOptions = {}) {
    this.setTimerDefault = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimerDefault =
      options.clearTimer ??
      ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  }

  /** Create and register the token for `turnId`, replacing the current one. */
  arm(turnId: string, opts: ArmOptions = {}): VoiceTurnCancellationToken {
    this.disposeActiveTimer();

    const setTimer = opts.setTimer ?? this.setTimerDefault;
    const clearTimer = opts.clearTimer ?? this.clearTimerDefault;
    let timerHandle: unknown = null;

    const token = createToken(turnId, () => {
      if (timerHandle !== null) {
        clearTimer(timerHandle);
        timerHandle = null;
      }
    });

    if (opts.budgetMs !== undefined && opts.budgetMs >= 0) {
      timerHandle = setTimer(() => {
        timerHandle = null;
        token.abort('timeout');
      }, opts.budgetMs);
    }

    this.activeToken = token;
    this.activeTimer = timerHandle;
    this.activeClearTimer = clearTimer;
    return token;
  }

  /** The most recently armed token, or null if none has been armed yet. */
  current(): VoiceTurnCancellationToken | null {
    return this.activeToken;
  }

  /** Abort the current token, if any, with `reason`. Idempotent (first reason wins). */
  abortCurrent(reason: VoiceTurnCancelReason): void {
    this.activeToken?.abort(reason);
  }

  /**
   * Bidirectional bind to an external `AbortSignal`: an external abort
   * propagates into the current token as `'external'`, and downstream
   * consumers can still take `token.signal` directly to observe either
   * direction. Returns an unsubscribe function.
   */
  bindExternal(signal: AbortSignal): () => void {
    if (signal.aborted) {
      this.activeToken?.abort('external');
      return () => {};
    }
    const onAbort = () => {
      this.activeToken?.abort('external');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    return () => {
      signal.removeEventListener('abort', onAbort);
    };
  }

  private disposeActiveTimer(): void {
    if (this.activeTimer !== null && this.activeClearTimer) {
      this.activeClearTimer(this.activeTimer);
    }
    this.activeTimer = null;
    this.activeClearTimer = null;
  }
}
