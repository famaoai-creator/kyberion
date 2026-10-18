import { randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import {
  resolveIsolatedTextGenerator,
  type IsolatedTextGenerator,
} from '../provider/isolated-text-generator.js';
import {
  assertReasoningEgressAllowed,
  withReasoningPayloadScope,
} from '../reasoning/reasoning-egress-scope.js';
import { frameUntrustedInput } from '../untrusted-input-framing.js';
import {
  appendDiscussionEvent,
  claimDiscussionProviderExecution,
  normalizeDiscussionConfig,
  readDiscussionRoom,
} from './discussion-store.js';
import type { DiscussionProvider, DiscussionRoomState } from './discussion-types.js';

export class DiscussionProviderError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super('[' + code + '] ' + message);
    this.name = 'DiscussionProviderError';
  }
}

/** Provider stderr can contain private prompts or credentials. Only our fixed diagnostics are persisted. */
export function safeDiscussionError(error: unknown): string {
  return error instanceof DiscussionProviderError
    ? error.message
    : '[DISCUSSION_FAILED] Discussion could not finish. No automatic retry or provider substitution was made.';
}

export function initializeDiscussionExecution(
  room: DiscussionRoomState,
  mode: 'scripted' | 'reasoning'
): void {
  if (room.execution) return;
  if (room.messages.length || room.participants.length) {
    if (mode === 'reasoning')
      throw new DiscussionProviderError(
        'DISCUSSION_RESTART_REQUIRED',
        'This historical room has unknown execution provenance. Start a new room to use an explicit provider.'
      );
    return; // Never relabel historical scripted output as observed execution.
  }
  const config = normalizeDiscussionConfig(room.config);
  appendDiscussionEvent(room.id, {
    type: 'execution_initialized',
    execution: {
      requested_mode: config.speaker,
      actual_mode: mode,
      requested_provider: config.provider ?? null,
      provider: null,
      model: null,
      call_budget: mode === 'scripted' ? 0 : config.max_provider_calls!,
      timeout_ms: config.provider_timeout_ms!,
      internal_turn_limit: mode === 'reasoning' && config.provider === 'claude' ? 3 : null,
    },
  });
}

/** One room, one explicitly selected isolated adapter, no retries or fallback chain. */
export class DiscussionProviderSession {
  private readonly generator: IsolatedTextGenerator;
  private readonly provider: DiscussionProvider;
  private halted = false;
  private inFlight = false;

  constructor(private readonly roomId: string) {
    const room = this.room();
    const provider = room.config.provider;
    if (provider !== 'claude' && provider !== 'codex') {
      throw new DiscussionProviderError(
        'DISCUSSION_PROVIDER_REQUIRED',
        'Select Claude or Codex explicitly, or start an explicitly scripted room.'
      );
    }
    this.provider = provider;
    const prior = room.execution;
    if (prior) {
      if (prior.actual_mode !== 'reasoning' || prior.requested_provider !== provider) {
        throw new DiscussionProviderError(
          'DISCUSSION_PROVENANCE_MISMATCH',
          'The saved execution mode/provider cannot change. Start a new room.'
        );
      }
      if (prior.attempts.length > 0) {
        throw new DiscussionProviderError(
          'DISCUSSION_RESTART_REQUIRED',
          'This room already spent provider calls before its engine stopped. Start a new room; interrupted calls are never retried automatically.'
        );
      }
    }
    // Across multiple surface processes, only one session can reserve a room.
    // Keep this claim even if resolution or initialization later fails.
    try {
      claimDiscussionProviderExecution(this.roomId);
    } catch {
      throw new DiscussionProviderError(
        'DISCUSSION_RESTART_REQUIRED',
        'Provider execution is already reserved or its claim cannot be safely created. Its prior outcome may be unknown. Start a new room; no automatic retry was made.'
      );
    }
    initializeDiscussionExecution(room, 'reasoning');
    try {
      this.generator = resolveIsolatedTextGenerator(provider);
    } catch {
      throw new DiscussionProviderError(
        'DISCUSSION_PROVIDER_UNAVAILABLE',
        'The selected isolated provider is unavailable. Check its existing setup, then start a new room.'
      );
    }
  }

  private room(): DiscussionRoomState {
    const room = readDiscussionRoom(this.roomId);
    if (!room)
      throw new DiscussionProviderError(
        'DISCUSSION_ROOM_MISSING',
        'The discussion room is no longer available.'
      );
    return room;
  }

  async generate<T>(
    operation: string,
    instruction: string,
    context: string,
    schema: ZodType<T>,
    shouldStop?: () => boolean
  ): Promise<T> {
    if (this.halted || this.inFlight)
      throw new DiscussionProviderError(
        'DISCUSSION_SESSION_HALTED',
        'This provider session cannot start another invocation. Start a new room after a failed or interrupted run.'
      );
    const room = this.room();
    const execution = room.execution;
    if (!execution || execution.actual_mode !== 'reasoning')
      throw new DiscussionProviderError(
        'DISCUSSION_PROVENANCE_MISSING',
        'Provider execution metadata is unavailable. Start a new room.'
      );
    if (execution.attempts.length >= Math.min(32, execution.call_budget)) {
      throw new DiscussionProviderError(
        'DISCUSSION_BUDGET_EXHAUSTED',
        'The room-lifetime provider call budget is exhausted. Start a new room to authorize another bounded run.'
      );
    }
    const scope = {
      tier: room.scope.tier ?? ('confidential' as const),
      tenant_slug: room.scope.tenant_slug,
      purpose: 'discussion:' + operation,
      training_use:
        room.scope.tier === 'public' ? ('training_eligible' as const) : ('zero_retention' as const),
    };
    return withReasoningPayloadScope(scope, async () => {
      // Explicitly assert here as well as in the built-in transports: an adapter
      // must not bypass the room's tenant/tier policy by omitting its own assertion.
      try {
        assertReasoningEgressAllowed(this.generator.reasoningBackend);
      } catch {
        throw new DiscussionProviderError(
          'DISCUSSION_EGRESS_DENIED',
          'Existing tenant/tier policy does not authorize this provider for the room. Review the existing provider approval; no provider invocation was made.'
        );
      }
      const stopped = () => {
        const latest = this.room();
        return (
          ['stopped', 'failed', 'concluded'].includes(latest.status) ||
          latest.pending_commands.some((pending) => pending.command.kind === 'stop') ||
          Boolean(shouldStop?.())
        );
      };
      if (stopped())
        throw new DiscussionProviderError(
          'DISCUSSION_PROVIDER_ABORTED',
          'Generation was stopped before the provider invocation.'
        );
      const id = 'call-' + randomUUID().slice(0, 12);
      appendDiscussionEvent(this.roomId, {
        type: 'provider_call_started',
        id,
        operation,
        provider: this.provider,
      });
      this.inFlight = true;
      const abortController = new AbortController();
      let timedOut = false;
      const timeoutMs = Math.min(60000, execution.timeout_ms);
      const timeout = setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, timeoutMs);
      const stopCheck = setInterval(() => {
        try {
          if (stopped()) abortController.abort();
        } catch {
          abortController.abort();
        }
      }, 100);
      try {
        // Await transport termination after abort; never race ahead and start a
        // second invocation while a timed-out child is still running.
        const result = await this.generator.generate({
          systemPrompt: instruction,
          userPrompt: frameUntrustedInput({
            data: context,
            source: 'discussion room goal and transcript',
          }),
          schema,
          abortController,
          timeoutMs,
          metricsLabel: 'discussion:' + operation,
        });
        if (timedOut)
          throw new DiscussionProviderError(
            'DISCUSSION_PROVIDER_TIMEOUT',
            'Provider call timed out and was aborted. No automatic retry was made.'
          );
        if (abortController.signal.aborted || stopped()) {
          // A stop can arrive after the response but before the poll timer.
          // Discard that response and record cancellation consistently.
          abortController.abort();
          throw new DiscussionProviderError(
            'DISCUSSION_PROVIDER_ABORTED',
            'Provider generation was stopped. No automatic retry was made.'
          );
        }
        // Defend the seam even if a custom registered adapter violates its contract.
        const parsed = schema.parse(result);
        appendDiscussionEvent(this.roomId, {
          type: 'provider_call_finished',
          id,
          status: 'succeeded',
        });
        return parsed;
      } catch (error) {
        this.halted = true;
        const code = timedOut
          ? 'DISCUSSION_PROVIDER_TIMEOUT'
          : abortController.signal.aborted
            ? 'DISCUSSION_PROVIDER_ABORTED'
            : 'DISCUSSION_PROVIDER_FAILED';
        appendDiscussionEvent(this.roomId, {
          type: 'provider_call_finished',
          id,
          status: timedOut ? 'timed_out' : abortController.signal.aborted ? 'aborted' : 'failed',
          error_code: code,
        });
        if (error instanceof DiscussionProviderError) throw error;
        throw new DiscussionProviderError(
          code,
          timedOut
            ? 'Provider call timed out and was aborted. No automatic retry was made.'
            : abortController.signal.aborted
              ? 'Provider generation was stopped. No automatic retry was made.'
              : 'The selected provider failed or returned invalid output. No scripted substitution or automatic retry was made.'
        );
      } finally {
        this.inFlight = false;
        clearTimeout(timeout);
        clearInterval(stopCheck);
      }
    });
  }
}
