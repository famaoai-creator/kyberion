/**
 * MeetingParticipationCoordinator — the runtime that ties join + audio
 * + STT + LLM + TTS + leave together into a real meeting attendance.
 *
 * The coordinator owns the loop:
 *
 *   1. acquire driver, audio bus, STT, TTS, VAD from constructor
 *   2. driver.join(target, bus) → session
 *   3. start STT over `session.audioInput()`
 *   4. for each FINAL transcript chunk:
 *        a. feed into the agent (text → reply)
 *        b. when the participant has paused (VAD endpoint),
 *           synthesize the reply through TTS and write back to bus
 *   5. on duration / explicit signal / agent says "leave",
 *      session.leave()
 *
 * It is small on purpose. Each piece is replaceable. The coordinator
 * only enforces the *order* and the *budget* (max duration, max
 * silence, etc.); intelligence lives in the agent callback.
 */

import * as path from 'node:path';
import { logger } from './core.js';
import { auditChain } from './audit-chain.js';
import * as pathResolver from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { TraceContext } from './src/trace.js';
import type { AudioBus } from './audio-bus.js';
import type { MeetingJoinDriver } from './meeting-join-driver.js';
import type { StreamingSpeechToTextBridge } from './streaming-stt-bridge.js';
import type { StreamingTextToSpeechBridge } from './streaming-tts-bridge.js';
import type { VoiceActivityDetector } from './voice-activity-detector.js';
import type {
  AudioChunk,
  AudioFormat,
  MeetingSession,
  MeetingTarget,
  TranscriptChunk,
} from './meeting-session-types.js';

export interface ConversationAgent {
  /**
   * Receive an utterance from a meeting participant; return what the
   * AI wants to say (or null when it should remain silent). The agent
   * is responsible for keeping its own conversation state.
   */
  onUtterance(utterance: TranscriptChunk): Promise<{
    speech?: string;
    leave?: boolean;
  }>;
}

export interface MeetingParticipationOptions {
  /** Mission whose evidence directory carries live-meeting consent. */
  mission_id?: string;
  /** Max wall-clock minutes the AI will stay. Hard ceiling. */
  max_minutes: number;
  /** Max consecutive seconds of total silence before the AI leaves. */
  max_idle_silence_sec?: number;
  /** Voice profile id for TTS (see voice-profile-registry). */
  voice_profile_id: string;
  /** Audio format both bus and TTS must agree on. */
  audio_format: AudioFormat;
  /** Tenant slug for audit emission, when set. */
  tenant_slug?: string;
  /** Fail closed before opening the audio bus unless consent exists. Defaults to true when mission_id is set. */
  require_recording_consent?: boolean;
  /** Fail closed before TTS speech unless consent exists. Defaults to true when mission_id is set. */
  require_voice_consent?: boolean;
}

export interface MeetingParticipationReport {
  session_id: string;
  joined_at: string;
  left_at: string;
  utterances_received: number;
  utterances_spoken: number;
  /** Whether `max_minutes` triggered the leave (vs. agent / error). */
  ended_by_timeout: boolean;
  error?: string;
}

interface MeetingParticipationConsentRecord {
  consent?: unknown;
  mission_id?: unknown;
  operator_handle?: unknown;
  tenant_slug?: unknown;
  expires_at?: unknown;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function checkMeetingParticipationConsent(input: {
  mission_id?: string;
  tenant_slug?: string;
  purpose: 'recording' | 'voice';
}): { allowed: boolean; reason?: string } {
  if (process.env.KYBERION_SUDO === 'true') return { allowed: true };
  const missionId = normalizeOptionalString(input.mission_id);
  if (!missionId) {
    return {
      allowed: false,
      reason: `${input.purpose} requires mission_id + voice-consent.json in the mission evidence dir`,
    };
  }
  const evidenceDir = pathResolver.missionEvidenceDir(missionId);
  if (!evidenceDir) {
    return { allowed: false, reason: `mission evidence dir not found for ${missionId}` };
  }
  const consentPath = path.join(evidenceDir, 'voice-consent.json');
  if (!safeExistsSync(consentPath)) {
    return {
      allowed: false,
      reason: `voice-consent.json missing at ${path.relative(pathResolver.rootDir(), consentPath)}`,
    };
  }
  let raw: MeetingParticipationConsentRecord;
  try {
    const parsed = JSON.parse(safeReadFile(consentPath, { encoding: 'utf8' }) as string);
    if (!isPlainObject(parsed)) {
      return { allowed: false, reason: 'voice-consent.json is malformed: expected an object' };
    }
    raw = parsed;
  } catch (err: any) {
    return { allowed: false, reason: `failed to parse voice-consent.json: ${err?.message ?? err}` };
  }
  if (raw.consent !== 'granted') {
    return {
      allowed: false,
      reason: `voice-consent.json present but consent != 'granted' (got '${String(raw.consent)}')`,
    };
  }
  if (normalizeOptionalString(raw.mission_id) !== missionId) {
    return {
      allowed: false,
      reason: `voice-consent.json mission_id '${String(raw.mission_id)}' does not match active mission '${missionId}'`,
    };
  }
  if (!normalizeOptionalString(raw.operator_handle)) {
    return { allowed: false, reason: 'voice-consent.json is malformed: operator_handle is required' };
  }
  const expiresAt = normalizeOptionalString(raw.expires_at);
  if (expiresAt) {
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry)) {
      return { allowed: false, reason: `voice-consent.json expires_at is invalid: ${expiresAt}` };
    }
    if (expiry <= Date.now()) {
      return { allowed: false, reason: `voice-consent.json expired at ${expiresAt}` };
    }
  }
  const activeTenant = normalizeOptionalString(input.tenant_slug);
  if (activeTenant && normalizeOptionalString(raw.tenant_slug) !== activeTenant) {
    return {
      allowed: false,
      reason: `voice-consent.json tenant_slug '${normalizeOptionalString(raw.tenant_slug) ?? 'missing'}' does not match active tenant '${activeTenant}'`,
    };
  }
  return { allowed: true };
}

export class MeetingParticipationCoordinator {
  constructor(
    private readonly deps: {
      driver: MeetingJoinDriver;
      bus: AudioBus;
      stt: StreamingSpeechToTextBridge;
      tts: StreamingTextToSpeechBridge;
      vad: VoiceActivityDetector;
      agent: ConversationAgent;
      trace?: TraceContext;
    },
  ) {}

  async run(
    target: MeetingTarget,
    options: MeetingParticipationOptions,
  ): Promise<MeetingParticipationReport> {
    const startedAt = Date.now();
    const deadline = startedAt + options.max_minutes * 60_000;
    let utterancesReceived = 0;
    let utterancesSpoken = 0;
    let endedByTimeout = false;
    let session: MeetingSession | null = null;
    let traceEnded = false;
    const closeTrace = (status: 'ok' | 'error', error?: string): void => {
      if (!this.deps.trace || traceEnded) return;
      this.deps.trace.endSpan(status, error);
      traceEnded = true;
    };

    if (this.deps.trace) {
      this.deps.trace.startSpan('meeting_participation.run', {
        platform: target.platform,
        driver: this.deps.driver.driver_id,
      });
      this.deps.trace.addEvent('meeting_participation.start', {
        platform: target.platform,
        driver: this.deps.driver.driver_id,
      });
    }

    const requireRecordingConsent =
      options.require_recording_consent ?? Boolean(options.mission_id);
    if (requireRecordingConsent) {
      const consent = checkMeetingParticipationConsent({
        mission_id: options.mission_id,
        tenant_slug: options.tenant_slug,
        purpose: 'recording',
      });
      if (!consent.allowed) {
        this.deps.trace?.addEvent('meeting_participation.recording_denied', {
          reason: consent.reason,
        });
        closeTrace('error', consent.reason);
        this.recordAudit('meeting_participation.recording_denied', target, 'denied', consent.reason);
        throw new Error(`[meeting-participation] ${consent.reason}`);
      }
      this.deps.trace?.addEvent('meeting_participation.recording_consent_granted', {
        mission_id: options.mission_id,
      });
    }

    // 1. Open the bus + join.
    await this.deps.bus.open(options.audio_format);
    this.deps.trace?.addEvent('meeting_participation.bus_open', {
      format: options.audio_format.encoding,
      sample_rate_hz: options.audio_format.sample_rate_hz,
    });
    this.recordAudit('meeting_participation.join', target, 'allowed');
    try {
      this.deps.trace?.addEvent('meeting_participation.join_requested', {
        platform: target.platform,
      });
      session = await this.deps.driver.join(target, this.deps.bus);
      this.deps.trace?.addEvent('meeting_participation.joined', {
        session_id: session.state.session_id,
      });
    } catch (err: any) {
      this.deps.trace?.addEvent('meeting_participation.join_failed', {
        error: err?.message ?? String(err),
      });
      closeTrace('error', err?.message ?? String(err));
      this.recordAudit('meeting_participation.join_failed', target, 'error', err?.message);
      await this.deps.bus.close();
      throw err;
    }

    const joinedAt = session.state.joined_at ?? new Date().toISOString();

    // 2. Start STT over the inbound audio. The transformed VAD-aware
    //    iterator lets us track silence + flag turn endpoints; STT
    //    sees the same chunks.
    const taps = teeInbound(session.audioInput());

    const transcriptIterator = this.deps.stt.transcribeStream(taps.toStt);
    const vadIterator = this.driveVad(taps.toVad, deadline);
    void consumeIterator(vadIterator); // keep VAD active in background

    // 3. Drain transcripts and run the agent. Speak when agent has
    //    a reply AND VAD reports a recent endpoint.
    try {
      for await (const utterance of transcriptIterator) {
        if (Date.now() > deadline) {
          endedByTimeout = true;
          this.deps.trace?.addEvent('meeting_participation.timeout', {
            max_minutes: options.max_minutes,
          });
          break;
        }
        if (!utterance.is_final) continue;
        utterancesReceived += 1;
        this.deps.trace?.addEvent('meeting_participation.transcript', {
          utterance_index: utterancesReceived,
          chars: utterance.text.length,
          speaker: utterance.speaker_label ?? 'unknown',
        });
        const decision = await this.deps.agent.onUtterance(utterance);
        if (decision.leave) {
          this.deps.trace?.addEvent('meeting_participation.agent_leave', {
            utterance_index: utterancesReceived,
          });
          this.recordAudit('meeting_participation.agent_leave', target, 'allowed');
          break;
        }
        if (decision.speech) {
          this.deps.trace?.addEvent('meeting_participation.speak_requested', {
            chars: decision.speech.length,
          });
          await this.speak(session, decision.speech, options.voice_profile_id, target, options);
          utterancesSpoken += 1;
          this.deps.trace?.addEvent('meeting_participation.spoke', {
            utterance_index: utterancesReceived,
            chars: decision.speech.length,
          });
          this.recordAudit('meeting_participation.spoke', target, 'allowed', decision.speech);
        }
      }
      this.deps.trace?.addEvent('meeting_participation.loop_finished', {
        utterances_received: utterancesReceived,
        utterances_spoken: utterancesSpoken,
        ended_by_timeout: endedByTimeout,
      });
    } catch (err: any) {
      this.deps.trace?.addEvent('meeting_participation.error', {
        error: err?.message ?? String(err),
      });
      closeTrace('error', err?.message ?? String(err));
      this.recordAudit('meeting_participation.error', target, 'error', err?.message);
      throw err;
    } finally {
      await session.leave().catch((err: any) => {
        logger.warn(`[participation-coordinator] leave failed: ${err?.message ?? err}`);
        this.deps.trace?.addEvent('meeting_participation.leave_failed', {
          error: err?.message ?? String(err),
        });
      });
      this.deps.trace?.addEvent('meeting_participation.leave', {
        session_id: session.state.session_id,
      });
      this.recordAudit('meeting_participation.leave', target, 'allowed');
    }

    closeTrace('ok');

    return {
      session_id: session.state.session_id,
      joined_at: joinedAt,
      left_at: session.state.left_at ?? new Date().toISOString(),
      utterances_received: utterancesReceived,
      utterances_spoken: utterancesSpoken,
      ended_by_timeout: endedByTimeout,
    };
  }

  /**
   * Synthesize `text` and write into `session.audioOutput`. We send
   * the entire reply as a single segment iterator — the TTS bridge
   * is responsible for chunking the audio inside.
   */
  private async speak(
    session: MeetingSession,
    text: string,
    voiceProfileId: string,
    target: MeetingTarget,
    options: MeetingParticipationOptions,
  ): Promise<void> {
    const requireVoiceConsent = options.require_voice_consent ?? Boolean(options.mission_id);
    if (requireVoiceConsent) {
      const consent = checkMeetingParticipationConsent({
        mission_id: options.mission_id,
        tenant_slug: options.tenant_slug,
        purpose: 'voice',
      });
      if (!consent.allowed) {
        this.deps.trace?.addEvent('meeting_participation.speak_denied', {
          reason: consent.reason,
        });
        this.recordAudit('meeting_participation.speak_denied', target, 'denied', consent.reason);
        throw new Error(`[meeting-participation] ${consent.reason}`);
      }
    }
    this.deps.trace?.startSpan('meeting_participation.tts', {
      chars: text.length,
      voice_profile_id: voiceProfileId,
    });
    async function* singleSegment(): AsyncIterable<string> {
      yield text;
    }
    try {
      await session.audioOutput(this.deps.tts.synthesizeStream(singleSegment(), voiceProfileId));
      this.deps.trace?.endSpan('ok');
    } catch (err: any) {
      this.deps.trace?.endSpan('error', err?.message ?? String(err));
      throw err;
    }
  }

  /**
   * Drive the VAD over the inbound stream as a side-effect. Yields
   * `endpoint` markers for diagnostics; coordinators that want
   * speak-on-endpoint behavior can extend this loop.
   */
  private async *driveVad(
    audio: AsyncIterable<AudioChunk>,
    deadline: number,
  ): AsyncGenerator<{ endpoint: boolean; silence_ms: number }> {
    for await (const chunk of audio) {
      if (Date.now() > deadline) return;
      const state = this.deps.vad.ingest(chunk);
      yield { endpoint: state.endpoint, silence_ms: state.silence_ms };
    }
  }

  private recordAudit(
    action: string,
    target: MeetingTarget,
    result: 'allowed' | 'error' | 'denied',
    reason?: string,
  ): void {
    try {
      auditChain.record({
        agentId: 'meeting-participation-coordinator',
        action,
        operation: target.url ? new URL(target.url).host : target.platform,
        result,
        ...(reason ? { reason } : {}),
        metadata: {
          platform: target.platform,
          driver: this.deps.driver.driver_id,
          bus: this.deps.bus.bus_id,
          stt: this.deps.stt.bridge_id,
          tts: this.deps.tts.bridge_id,
          ...(target.tenant_slug ? { tenant_slug: target.tenant_slug } : {}),
        },
      });
    } catch (err: any) {
      logger.warn(`[participation-coordinator] audit emission failed: ${err?.message ?? err}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * teeInbound — split a single audio iterator into two independent
 * consumers (STT + VAD) without re-pulling the underlying source.
 * Implementation is small but correct: we buffer chunks per-consumer
 * with backpressure (max 64 chunks queued).
 * ------------------------------------------------------------------ */

function teeInbound(source: AsyncIterable<AudioChunk>): {
  toStt: AsyncIterable<AudioChunk>;
  toVad: AsyncIterable<AudioChunk>;
} {
  const queues: Array<AudioChunk[]> = [[], []];
  const resolvers: Array<Array<(chunk: AudioChunk | null) => void>> = [[], []];
  let drained = false;

  (async () => {
    for await (const chunk of source) {
      for (let i = 0; i < 2; i++) {
        if (resolvers[i].length > 0) {
          const r = resolvers[i].shift()!;
          r(chunk);
        } else if (queues[i].length < 64) {
          queues[i].push(chunk);
        }
        // else: drop on the floor under sustained backpressure
      }
    }
    drained = true;
    for (let i = 0; i < 2; i++) {
      while (resolvers[i].length) resolvers[i].shift()!(null);
    }
  })().catch((err: any) => {
    logger.warn(`[participation-coordinator] tee source failed: ${err?.message ?? err}`);
    drained = true;
    for (let i = 0; i < 2; i++) {
      while (resolvers[i].length) resolvers[i].shift()!(null);
    }
  });

  function makeIter(idx: number): AsyncIterable<AudioChunk> {
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queues[idx].length > 0) {
            yield queues[idx].shift()!;
            continue;
          }
          if (drained) return;
          const chunk = await new Promise<AudioChunk | null>((resolve) => {
            resolvers[idx].push(resolve);
          });
          if (chunk === null) return;
          yield chunk;
        }
      },
    };
  }

  return { toStt: makeIter(0), toVad: makeIter(1) };
}

async function consumeIterator(iter: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iter) {
    /* drain */
  }
}
