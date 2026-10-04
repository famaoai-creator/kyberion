/**
 * Conversation Engine — the generic Interaction Controller (CE-01..CE-08).
 *
 * A voice conversation is not `STT → LLM → TTS` in series; it is a control
 * loop the reasoning backend only feeds:
 *
 *   Observe → Infer State → Decide Who Acts → Act → Observe
 *
 * This engine is the decide step, kept pure and event-driven: every input
 * carries `at_ms`, which is the only clock. It composes injected deciders
 * (interruption arbiter, end-of-turn hold, respond gate, speculation policy)
 * with the interaction-layer modules (language packs, utterance intent,
 * continuous signals, user rhythm, backchannel policy) and emits actions —
 * the caller performs them (pause output, dispatch the turn, emit a
 * backchannel).
 *
 * Voice is the reference adapter (`libs/core/voice/voice-turn-taking.ts`),
 * but nothing here mentions audio, VAD, or TTS: the same machine can drive
 * text chat or meeting facilitation, which is what makes it the seed of an
 * "AI runs the company" interaction OS.
 */

import { deriveInteractionState, type InteractionState } from './interaction-state.js';
import {
  InteractionSignalsTracker,
  type EndOfTurnScorer,
  type InteractionSignals,
} from './interaction-signals.js';
import {
  classifyUtteranceIntent,
  type UtteranceIntent,
  type UtteranceIntentResult,
} from './utterance-intent.js';
import { resolveLanguagePack, type LanguagePack } from './language-pack.js';
import { BackchannelPolicy, type BackchannelPolicyOptions } from './backchannel-policy.js';
import { UserRhythm, type RhythmAdjustments, type UserRhythmOptions } from './user-rhythm.js';

/* ------------------------------------------------------------------------- *
 * Events
 * ------------------------------------------------------------------------- */

/** Canonical, modality-neutral event names. */
export type InteractionEventType =
  | 'speech_onset'
  | 'speech_offset'
  /** A pause inside an ongoing remote utterance (not an endpoint). */
  | 'speech_pause'
  /** Remote speech resumed after a `speech_pause`. */
  | 'speech_resume'
  | 'transcript_partial'
  | 'transcript_final'
  | 'output_started'
  /** Incremental agent output text (replaces the current output buffer). */
  | 'output_partial'
  | 'output_ended'
  /** Agent-side short reaction began/ended (does not take the floor). */
  | 'reaction_started'
  | 'reaction_ended'
  | 'tick';

/** Legacy voice-loop names — accepted and mapped to the canonical events. */
export type LegacyInteractionEventType =
  'vad_start' | 'vad_silence' | 'stt_partial' | 'stt_final' | 'tts_start' | 'tts_end';

const LEGACY_EVENT_MAP: Record<LegacyInteractionEventType, InteractionEventType> = {
  vad_start: 'speech_onset',
  vad_silence: 'speech_offset',
  stt_partial: 'transcript_partial',
  stt_final: 'transcript_final',
  tts_start: 'output_started',
  tts_end: 'output_ended',
};

export interface InteractionEvent {
  type: InteractionEventType | LegacyInteractionEventType;
  at_ms: number;
  /** Transcript for transcript events; spoken text for output/reaction events (echo checks). */
  text?: string;
  /** Onset energy, for arbiters that weigh speech pressure. */
  rms?: number;
  /**
   * Adapter-specific tick payload (e.g. `{ chunk, partials }` — the engine
   * stays opaque; the injected arbiter understands the shape).
   * `silenceDeltaMs` accumulates intra-utterance pause duration in evidence
   * units (e.g. audio ms) — independent of the event clock, which may run
   * faster than real time under replayed input.
   */
  payload?: { chunk?: unknown; partials?: readonly string[]; silenceDeltaMs?: number };
}

/* ------------------------------------------------------------------------- *
 * Actions
 * ------------------------------------------------------------------------- */

export type InteractionCancelReason =
  'barge_in' | 'eot_revoked' | 'user_cancel' | 'timeout' | 'external';

export type InterruptionAction =
  | { type: 'pause_tts' }
  | { type: 'resume_tts'; reason: 'no_words' | 'echo' }
  | { type: 'hard_stop'; words: string };

export type InteractionAction =
  | { type: 'pause_tts' }
  | { type: 'resume_tts'; reason: 'no_words' | 'echo' }
  | { type: 'hard_stop'; words: string; intent?: UtteranceIntent }
  | { type: 'hold'; text: string; intent?: UtteranceIntent }
  | { type: 'commit'; text: string; intent?: UtteranceIntent; pure?: boolean }
  | { type: 'drop'; reason: string; text: string; intent?: UtteranceIntent }
  | { type: 'start_speculative'; partial: string }
  | { type: 'abort_speculative'; reason: InteractionCancelReason }
  /** Conversational-response shortcut: speak `text` without any reasoning. */
  | { type: 'emit_backchannel'; text: string };

/* ------------------------------------------------------------------------- *
 * Injected deciders — the adapter supplies implementations
 * ------------------------------------------------------------------------- */

/** Energy/STT-confirmed interruption arbiter (voice: TwoStageBargeIn). */
export interface InterruptionArbiter {
  observeVadStart(rms?: number): InterruptionAction[];
  observeVadEnd(): InterruptionAction[];
  observePartial(text: string): InterruptionAction[];
  tick(): InterruptionAction[];
  /**
   * Chunk-level observation while agent output is active. Adapters that feed
   * per-chunk energy (voice: the two-stage VAD probe) implement this and the
   * engine routes tick payloads here instead of `tick()`.
   */
  observeTick?(chunk: unknown, partials: readonly string[]): InterruptionAction[];
  /** Audio (or other evidence) buffered since provisional pause, for replay. */
  bufferedChunks?(): readonly unknown[];
  reset(): void;
  /** Optional phase readout ('paused'/'stopped'/...) for signals. */
  readonly state?: string;
}

/** Held-turn aggregator (voice: EotHoldAggregator). */
export interface EndOfTurnHold {
  readonly pending: string;
  offer(finalText: string): { commit: boolean; text: string };
  tick(): { commit: boolean; text: string } | null;
  reset(): void;
}

export interface RespondGateContext {
  recentAssistantText?: string;
  ageMs?: number;
  speaking?: boolean;
}

/** Whether a committed turn warrants a response (voice: shouldRespondToVoiceTurn). */
export type RespondGateFn = (
  text: string,
  ctx: RespondGateContext
) => { respond: boolean; reason?: string };

/** Whether a transcript looks like the agent's own output bleeding back. */
export type EchoChecker = (text: string, ctx: RespondGateContext) => boolean;

/** Whether the speculative reply built on `partial` may be adopted by `final`. */
export type SpeculationMatcher = (partial: string, final: string) => boolean;

export interface SpeculationPolicyShape {
  enabled: boolean;
  tentativeSilenceMs: number;
  minPartialChars: number;
}

/** Count of confirming words in a fragment (interruption signal input). */
export type WordCounter = (text: string) => number;

/* ------------------------------------------------------------------------- *
 * Options
 * ------------------------------------------------------------------------- */

export interface ConversationEngineOptions {
  /** Interruption arbiter; absent → remote speech never interrupts output. */
  interruption?: InterruptionArbiter;
  /** End-of-turn hold; absent → every final commits immediately. */
  eot?: EndOfTurnHold;
  /** Respond gate; absent → every non-empty turn commits. */
  respondGate?: RespondGateFn;
  /** Own-output echo check; absent → never treated as echo. */
  echo?: EchoChecker;
  speculation?: Partial<SpeculationPolicyShape>;
  speculationMatcher?: SpeculationMatcher;
  /** Confirming-word counter for the interruption signal. */
  wordCounter?: WordCounter;
  /** After silence, how long to wait for a final before held text may commit. Default 800ms. */
  finalWaitMs?: number;
  /** How long spoken agent text stays eligible for echo matching. Default 9000ms. */
  echoWindowMs?: number;
  /** Language packs (required — the engine never hardcodes a language). */
  packs: readonly LanguagePack[];
  /** Pack id to force, or 'auto' (default: detect per text). */
  language?: string;
  /** EOT scorer for the signals feed; defaults to a pack-driven heuristic. */
  eotScorer?: EndOfTurnScorer;
  /** Agent backchannel emission; `false` disables outright. */
  backchannel?: BackchannelPolicyOptions | false;
  /** User rhythm tracking; adjustments apply once enough samples exist. */
  rhythm?: UserRhythmOptions | false;
  /** Utterance intent classification. Default true. */
  intent?: boolean;
  now?: () => number;
}

export class ConversationEngine {
  private readonly interruption: InterruptionArbiter | null;
  private readonly eot: EndOfTurnHold | null;
  private readonly respondGate: RespondGateFn | null;
  private readonly echo: EchoChecker;
  private readonly speculationPolicy: SpeculationPolicyShape;
  private readonly speculationMatcher: SpeculationMatcher;
  private readonly wordCounter: WordCounter;
  private readonly finalWaitMs: number;
  private readonly echoWindowMs: number;
  private readonly packs: readonly LanguagePack[];
  private readonly language?: string;
  private readonly signalsTracker: InteractionSignalsTracker;
  private readonly backchannelPolicy: BackchannelPolicy | null;
  private readonly rhythm: UserRhythm | null;
  private readonly intentEnabled: boolean;

  /** Engine clock — advanced only by `step()` inputs. Protected for adapters. */
  protected nowMs = 0;
  private outputActive = false;
  private outputIsReaction = false;
  private spoken: Array<{ text: string; at_ms: number }> = [];
  private remoteSpeaking = false;
  private speechStartedAt: number | null = null;
  private silenceAt: number | null = null;
  private intraUtterancePaused = false;
  private pausedMs = 0;
  private awaitingFinalUntil: number | null = null;
  private lastPartial = '';
  private lastPartialIntent: UtteranceIntentResult | null = null;
  private speculatedPartial = '';
  private speculative: { partial: string } | null = null;
  private outputSinceLastUtterance = false;
  private lastDetectedPack: LanguagePack | null = null;

  constructor(options: ConversationEngineOptions) {
    if (!options.packs || options.packs.length === 0) {
      throw new Error('conversation engine requires at least one language pack');
    }
    this.packs = options.packs;
    this.language = options.language;
    this.nowMs = 0;
    // All subcomponents share the event clock (at_ms) — deterministic under
    // the workbench's fake clock and consistent with the injected deciders.
    const now = options.now ?? (() => this.nowMs);
    this.finalWaitMs = options.finalWaitMs ?? 800;
    this.echoWindowMs = options.echoWindowMs ?? 9_000;
    this.interruption = options.interruption ?? null;
    this.eot = options.eot ?? null;
    this.respondGate = options.respondGate ?? null;
    this.echo = options.echo ?? (() => false);
    this.speculationPolicy = {
      enabled: false,
      tentativeSilenceMs: 250,
      minPartialChars: 4,
      ...options.speculation,
    };
    this.speculationMatcher = options.speculationMatcher ?? ((partial, final) => partial === final);
    this.wordCounter = options.wordCounter ?? defaultWordCounter;
    this.intentEnabled = options.intent ?? true;
    this.signalsTracker = new InteractionSignalsTracker({
      eotScorer: options.eotScorer ?? ((text) => packDrivenEot(text, this.packFor(text))),
      now,
    });
    this.backchannelPolicy =
      options.backchannel === false ? null : new BackchannelPolicy({ ...options.backchannel, now });
    this.rhythm = options.rhythm === false ? null : new UserRhythm({ ...options.rhythm, now });
  }

  /* ------------------------------ inspection ------------------------------ */

  /** The single legible turn state (CE-01). */
  get state(): InteractionState {
    return deriveInteractionState({
      outputActive: this.outputActive,
      outputPaused: this.interruption?.state === 'paused',
      remoteSpeaking: this.remoteSpeaking,
      eotPending: Boolean(this.eot?.pending),
      awaitingFinal: this.awaitingFinalUntil !== null && this.nowMs < this.awaitingFinalUntil,
      emittingBackchannel: this.outputIsReaction,
      preparingToAct: this.speculative !== null,
    });
  }

  /** Continuous signals (CE-03). */
  get signals(): InteractionSignals {
    return this.signalsTracker.signals;
  }

  /** Whether agent output (reply or reaction) is currently emitted. */
  get speaking(): boolean {
    return this.outputActive;
  }

  /**
   * The injected interruption arbiter, if any — adapters inspect it for
   * implementation detail (e.g. buffered audio to replay after a hard stop).
   */
  get arbiter(): InterruptionArbiter | null {
    return this.interruption;
  }

  /** User rhythm profile so far (null when rhythm tracking is disabled). */
  rhythmProfile() {
    return this.rhythm?.profile ?? null;
  }

  /** Rhythm-derived timing adjustments, or null before the sample floor. */
  rhythmAdjustments(): RhythmAdjustments | null {
    const adjustments = this.rhythm?.adjustments() ?? null;
    if (adjustments && this.backchannelPolicy) {
      this.backchannelPolicy.setMinInterval(adjustments.backchannelIntervalMs);
    }
    return adjustments;
  }

  /** Resolve the language pack for `text` — adapters route replies by it. */
  packForText(text: string): LanguagePack | null {
    return this.packFor(text);
  }

  /** Classify an utterance (CE-04); 'substantive' when intent is disabled. */
  classify(text: string): UtteranceIntentResult {
    if (!this.intentEnabled) return { intent: 'substantive', pure: false };
    return this.classifyInternal(text);
  }

  /** Raw intent classification — always runs (internal suppression uses it). */
  private classifyInternal(text: string): UtteranceIntentResult {
    const pack = this.packFor(text);
    if (!pack) return { intent: 'substantive', pure: false };
    return classifyUtteranceIntent(text, pack);
  }

  /** Attach intent metadata to an action only when intent surfacing is on. */
  private withIntent<A extends object>(
    action: A,
    intent: UtteranceIntentResult
  ): A & { intent?: UtteranceIntent } {
    return this.intentEnabled ? { ...action, intent: intent.intent } : { ...action };
  }

  /**
   * Pick a short reaction phrase for `contextText` — the same pool the
   * backchannel policy rotates through, falling back to the pack's first
   * agent backchannel when the policy is off.
   */
  pickReaction(contextText = ''): string {
    const pack = this.packFor(contextText || this.lastPartial);
    // i18n-exempt: JA fallback reaction — only used when the pack has no phrases
    const fallback = pack?.usesWordSpaces === false ? 'うん' : 'okay';
    if (!pack) return fallback;
    return this.backchannelPolicy?.pickPhrase(pack) ?? pack.agentBackchannels[0] ?? fallback;
  }

  /* -------------------------------- stepping ------------------------------ */

  step(input: InteractionEvent): InteractionAction[] {
    if (!Number.isFinite(input.at_ms)) throw new Error('interaction input at_ms must be finite');
    this.nowMs = Math.max(this.nowMs, input.at_ms);
    const type = canonicalType(input.type);
    const text = input.text ?? '';
    switch (type) {
      case 'output_started':
      case 'reaction_started':
        this.outputActive = true;
        this.outputIsReaction = type === 'reaction_started';
        this.outputSinceLastUtterance = true;
        this.interruption?.reset();
        this.spoken.push({ text, at_ms: this.nowMs });
        return [];
      case 'output_partial':
        // Streaming replies feed the joined output text here — echo checks
        // must see what is actually being emitted, not the (often empty)
        // text output_started carried.
        if (this.spoken.length === 0) this.spoken.push({ text, at_ms: this.nowMs });
        else this.spoken[this.spoken.length - 1]!.text = text;
        return [];
      case 'output_ended':
      case 'reaction_ended':
        this.outputActive = false;
        this.outputIsReaction = false;
        this.interruption?.reset();
        return [];
      case 'speech_onset':
        return this.onSpeechOnset(input.rms);
      case 'speech_pause':
        // A pause inside an ongoing utterance — the floor stays remote.
        // Duration accumulates via tick `silenceDeltaMs` so replayed input
        // cannot compress a pause into zero event-clock time.
        this.intraUtterancePaused = true;
        return [];
      case 'speech_resume': {
        this.intraUtterancePaused = false;
        this.pausedMs = 0;
        this.silenceAt = null;
        const actions: InteractionAction[] = [];
        if (this.speculative) actions.push(this.abortSpeculative('eot_revoked'));
        return actions;
      }
      case 'speech_offset':
        this.remoteSpeaking = false;
        this.intraUtterancePaused = false;
        this.pausedMs = 0;
        this.backchannelPolicy?.observeRemoteSpeechEnd();
        if (this.speechStartedAt !== null) {
          const utteranceMs = this.nowMs - this.speechStartedAt;
          this.signalsTracker.observeUtteranceEnd(utteranceMs);
          if (this.rhythm) {
            this.rhythm.observeUtterance({
              durationMs: utteranceMs,
              transcriptChars: this.lastPartial.length,
              atMs: this.nowMs,
            });
          }
        }
        this.speechStartedAt = null;
        this.silenceAt = this.nowMs;
        this.awaitingFinalUntil = this.nowMs + this.finalWaitMs;
        return [
          ...this.fromArbiter(this.interruption?.observeVadEnd() ?? []),
          ...this.maybeSpeculate(),
        ];
      case 'transcript_partial':
        if (!text.trim()) return [];
        this.lastPartial = text;
        this.lastPartialIntent = this.classifyInternal(text);
        this.signalsTracker.observeTranscript(text, this.lastPartialIntent.intent);
        if (this.outputActive) {
          this.signalsTracker.observeInterruptionCandidate({
            speechMs: this.speechStartedAt !== null ? this.nowMs - this.speechStartedAt : 0,
            confirmingWords: this.wordCounter(text),
            intent: this.lastPartialIntent.intent,
          });
          return this.fromArbiter(this.interruption?.observePartial(text) ?? []);
        }
        return this.maybeBackchannel();
      case 'transcript_final':
        return this.onFinal(text);
      case 'tick':
        return this.onTick(input);
    }
  }

  private onSpeechOnset(rms: number | undefined): InteractionAction[] {
    const actions: InteractionAction[] = [];
    this.remoteSpeaking = true;
    this.speechStartedAt = this.nowMs;
    // A gap only counts toward user pacing when no agent output intervened —
    // otherwise the measured "gap" is mostly the agent's own reply time.
    if (!this.outputSinceLastUtterance) this.rhythm?.observeSpeechStart(this.nowMs);
    this.outputSinceLastUtterance = false;
    this.backchannelPolicy?.observeRemoteSpeechStart(this.nowMs);
    this.lastPartial = '';
    this.lastPartialIntent = null;
    this.speculatedPartial = '';
    this.silenceAt = null;
    this.intraUtterancePaused = false;
    this.pausedMs = 0;
    this.awaitingFinalUntil = null;
    if (this.speculative) actions.push(this.abortSpeculative('eot_revoked'));
    if (this.outputActive) {
      actions.push(...this.fromArbiter(this.interruption?.observeVadStart(rms) ?? []));
    }
    return actions;
  }

  private onFinal(text: string): InteractionAction[] {
    this.awaitingFinalUntil = null;
    this.lastPartial = '';
    if (!text.trim()) return [];
    const intent = this.classifyInternal(text);
    this.signalsTracker.observeTranscript(text, intent.intent);
    const actions: InteractionAction[] = [];
    if (this.outputActive) {
      actions.push(...this.fromArbiter(this.interruption?.observePartial(text) ?? []));
      if (this.outputActive && this.isEcho(text)) {
        return [...actions, this.withIntent({ type: 'drop', reason: 'echo', text }, intent)];
      }
    }
    this.lastPartialIntent = intent;
    const result = this.eot?.offer(text) ?? { commit: true, text };
    if (!result.commit) {
      if (this.speculative) actions.push(this.abortSpeculative('eot_revoked'));
      return [...actions, this.withIntent({ type: 'hold', text: result.text }, intent)];
    }
    return [...actions, ...this.commit(result.text, intent)];
  }

  private onTick(input: InteractionEvent): InteractionAction[] {
    // Partial evidence on the barge channel sharpens intent BEFORE the
    // arbiter consumes it — a hard_stop reads `lastPartialIntent`.
    const partials = input.payload?.partials;
    const latestPartial = partials?.[partials.length - 1];
    if (latestPartial?.trim()) {
      this.lastPartial = latestPartial;
      this.lastPartialIntent = this.classifyInternal(latestPartial);
    }
    const arbiterActions =
      this.outputActive && input.payload?.chunk !== undefined && this.interruption?.observeTick
        ? this.interruption.observeTick(input.payload.chunk, partials ?? [])
        : (this.interruption?.tick() ?? []);
    if (this.intraUtterancePaused) this.pausedMs += input.payload?.silenceDeltaMs ?? 0;
    const actions = this.fromArbiter(arbiterActions);
    const finalPending = this.awaitingFinalUntil !== null && this.nowMs < this.awaitingFinalUntil;
    if (!this.outputActive && !this.remoteSpeaking && !finalPending) {
      const forced = this.eot?.tick();
      if (forced?.commit)
        actions.push(...this.commit(forced.text, this.classifyInternal(forced.text)));
    }
    return [...actions, ...this.maybeSpeculate(), ...this.maybeBackchannel()];
  }

  private commit(text: string, intent: UtteranceIntentResult): InteractionAction[] {
    const actions: InteractionAction[] = [];
    const speculative = this.speculative;
    const gate = this.respondGate?.(text, this.gateContext()) ?? { respond: true };
    if (gate.respond) {
      // Only turns that actually reach the agent count toward engagement.
      this.signalsTracker.observeCommittedTurn(intent.intent);
      if (this.rhythm) {
        if (intent.intent === 'backchannel') this.rhythm.observeUserBackchannel();
        else this.rhythm.observeSubstantiveTurn();
      }
    }
    if (!gate.respond) {
      // A dropped turn must not arm speculation afterwards — clear the
      // partial evidence it was built on.
      this.lastPartial = '';
      if (speculative) actions.push(this.abortSpeculative('external'));
      return [
        ...actions,
        this.withIntent({ type: 'drop', reason: gate.reason ?? 'not_addressed', text }, intent),
      ];
    }
    if (speculative && !this.speculationMatcher(speculative.partial, text)) {
      actions.push(this.abortSpeculative('eot_revoked'));
    }
    this.speculative = null;
    this.lastPartial = '';
    this.speculatedPartial = '';
    const committed = this.withIntent({ type: 'commit' as const, text }, intent);
    if (this.intentEnabled) (committed as { pure?: boolean }).pure = intent.pure;
    return [...actions, committed];
  }

  private maybeSpeculate(): InteractionAction[] {
    const policy = this.speculationPolicy;
    if (!policy.enabled || this.speculative || this.outputActive) return [];
    // Intra-utterance pauses (speech_pause, evidence-clocked) and post-offset
    // silence (event-clocked) both arm speculation. A stale partial must never
    // arm it: commit/drop paths clear lastPartial before this runs again.
    const silentMs = this.remoteSpeaking
      ? this.intraUtterancePaused
        ? this.pausedMs
        : null
      : this.silenceAt === null
        ? null
        : this.nowMs - this.silenceAt;
    if (silentMs === null || silentMs < this.effectiveTentativeSilenceMs()) return [];
    const partial = this.lastPartial.trim();
    if (partial.length < policy.minPartialChars || partial === this.speculatedPartial) return [];
    if (this.eot?.pending) return [];
    this.speculative = { partial };
    this.speculatedPartial = partial;
    return [{ type: 'start_speculative', partial }];
  }

  private maybeBackchannel(): InteractionAction[] {
    const policy = this.backchannelPolicy;
    if (!policy || this.outputActive || !this.remoteSpeaking) return [];
    // Require transcript evidence: it supplies both the language for the
    // phrase and the intent signal that suppresses reactions over holds and
    // corrections. Without partials (e.g. batch STT), stay silent.
    if (!this.lastPartial.trim() || !policy.shouldEmit(this.lastPartialIntent?.intent)) {
      return [];
    }
    const pack = this.packFor(this.lastPartial);
    if (!pack) return [];
    policy.markEmitted(this.nowMs);
    return [{ type: 'emit_backchannel', text: policy.pickPhrase(pack) }];
  }

  private effectiveTentativeSilenceMs(): number {
    return (
      this.rhythm?.adjustments()?.tentativeSilenceMs ?? this.speculationPolicy.tentativeSilenceMs
    );
  }

  private abortSpeculative(reason: InteractionCancelReason): InteractionAction {
    this.speculative = null;
    return { type: 'abort_speculative', reason };
  }

  private fromArbiter(actions: InterruptionAction[]): InteractionAction[] {
    const out: InteractionAction[] = [];
    for (const action of actions) {
      if (action.type === 'hard_stop') {
        this.outputActive = false;
        this.outputIsReaction = false;
        out.push(
          this.intentEnabled ? { ...action, intent: this.lastPartialIntent?.intent } : action
        );
      } else {
        out.push(action);
      }
    }
    return out;
  }

  /* ------------------------------- internals ------------------------------ */

  private packFor(text: string): LanguagePack | null {
    const pack = resolveLanguagePack(text, this.packs, this.language);
    // Remember the last pack resolved from real text — empty fragments
    // should reuse the conversation's language, not the default fallback.
    if (pack && text.trim()) this.lastDetectedPack = pack;
    return pack ?? this.lastDetectedPack;
  }

  private recentSpoken(): Array<{ text: string; at_ms: number }> {
    this.spoken = this.spoken.filter((entry) => this.nowMs - entry.at_ms <= this.echoWindowMs);
    return this.spoken;
  }

  private echoContext(entry: { text: string; at_ms: number } | undefined): RespondGateContext {
    if (!entry) return {};
    return {
      recentAssistantText: entry.text,
      ageMs: this.nowMs - entry.at_ms,
      speaking: this.outputActive,
    };
  }

  private gateContext(): RespondGateContext {
    const recent = this.recentSpoken();
    return this.echoContext(recent[recent.length - 1]);
  }

  /** Whether `text` matches recently emitted agent output (echo protection). */
  isEcho(text: string): boolean {
    return this.recentSpoken().some((entry) => this.echo(text, this.echoContext(entry)));
  }
}

/* ------------------------------ pure helpers ------------------------------ */

function canonicalType(type: InteractionEvent['type']): InteractionEventType {
  return (
    (LEGACY_EVENT_MAP as Record<string, InteractionEventType>)[type] ??
    (type as InteractionEventType)
  );
}

/** Fallback word counter: whitespace tokens, or ⌊chars/2⌋ for unspaced scripts. */
function defaultWordCounter(text: string): number {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 1) return tokens.length;
  return Math.floor(text.trim().length / 2);
}

/** Fallback EOT scorer: commit endings / sentence-final punctuation vs trailing markers. */
function packDrivenEot(text: string, pack: LanguagePack | null): number {
  const trimmed = text.trim();
  if (!trimmed || !pack) return 0.5;
  if (/[。！？!?.]$/.test(trimmed)) return 0.95;
  const lower = trimmed.normalize('NFKC').toLowerCase();
  for (const ending of pack.commitEndings) {
    if (lower.endsWith(ending.normalize('NFKC').toLowerCase())) return 0.9;
  }
  for (const filler of pack.eotFillers) {
    if (lower.endsWith(filler.normalize('NFKC').toLowerCase())) return 0.15;
  }
  for (const marker of pack.continuationMarkers) {
    const needle = marker.normalize('NFKC').toLowerCase();
    if (pack.usesWordSpaces ? lower.split(/\s+/).pop() === needle : lower.endsWith(needle)) {
      return 0.2;
    }
  }
  return 0.5;
}
